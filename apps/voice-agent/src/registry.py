"""Redis-backed agent registry for the voice-agent service.

Replaces the previous in-memory `agents` and `_active_pipelines` dicts so
state survives a pod restart cleanly. Each agent's metadata is mirrored
into a Redis hash; on startup the service reads any leftover entries
from a prior run and orphan-cleans them by removing the participant
from the LiveKit room (the asyncio.Task / rtc.Room references that
held the live SFU connection can't be reconstructed across processes,
so the only correct move is to disconnect and let banter-api re-spawn
the agent on demand).

Live pipeline objects (rtc.Room, asyncio.Task) stay in-memory in
`_local_pipelines` because they aren't serializable. The Redis side is
the source of truth for "which agents exist"; the in-memory side is the
source of truth for "what live resources we currently hold".

Key layout:
    voice-agents:active           → HASH<agent_id, json(agent_state)>
    voice-agents:provider-config  → HASH<org_key, json(provider_config)>
                                    (org_key = org UUID, or "_global" for
                                    the legacy org-less push; D-5)

Operations:
    register(agent_id, agent_state)  → HSET
    deregister(agent_id)             → HDEL, returns prior state or None
    list_all()                       → HGETALL → list[agent_state]
    snapshot_for_health()            → cheap COUNT for /health endpoint
    reconcile_orphans(livekit_room_service) → drain prior-pod entries
    save_provider_config(org_key, cfg)      → HSET (survives pod restart)
    load_provider_config(org_key)           → HGET or None
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("voice-agent.registry")

REDIS_KEY_ACTIVE = "voice-agents:active"
REDIS_KEY_PROVIDER_CONFIG = "voice-agents:provider-config"


class AgentRegistry:
    """Thin wrapper around a redis.asyncio client with graceful degrade.

    If Redis is unavailable at startup, the registry falls back to
    in-memory only (same behavior as before). All ops swallow Redis
    errors so the WS / FastAPI surface keeps functioning.
    """

    def __init__(self) -> None:
        self._redis: Optional[Any] = None
        self._connected = False

    async def connect(self) -> bool:
        """Connect to Redis. Returns True on success."""
        try:
            import redis.asyncio as aioredis  # imported lazily so the
            # service starts cleanly even if the redis package isn't
            # available in some constrained build.
        except ImportError:
            logger.warning("redis.asyncio not installed; registry runs in-memory only")
            return False

        url = os.environ.get("REDIS_URL", "")
        if not url:
            logger.warning("REDIS_URL not set; registry runs in-memory only")
            return False

        try:
            self._redis = aioredis.from_url(url, decode_responses=True)
            await self._redis.ping()
            self._connected = True
            logger.info("AgentRegistry connected to Redis at %s", _scrub_url(url))
            return True
        except Exception as exc:  # noqa: BLE001 — accept any failure mode
            logger.warning("Failed to connect to Redis: %s; registry runs in-memory only", exc)
            self._redis = None
            self._connected = False
            return False

    async def disconnect(self) -> None:
        if self._redis:
            try:
                await self._redis.close()
            except Exception:  # noqa: BLE001
                pass
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def register(self, agent_id: str, agent_state: dict) -> None:
        """Mirror a live agent's metadata to Redis."""
        if not self._connected or not self._redis:
            return
        try:
            await self._redis.hset(
                REDIS_KEY_ACTIVE, agent_id, json.dumps(agent_state, default=str)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry register(%s) failed: %s", agent_id, exc)

    async def deregister(self, agent_id: str) -> Optional[dict]:
        """Remove an agent's entry. Returns prior state if present."""
        if not self._connected or not self._redis:
            return None
        try:
            raw = await self._redis.hget(REDIS_KEY_ACTIVE, agent_id)
            await self._redis.hdel(REDIS_KEY_ACTIVE, agent_id)
            if raw:
                return json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry deregister(%s) failed: %s", agent_id, exc)
        return None

    async def list_all(self) -> list[dict]:
        """Return every active agent's metadata."""
        if not self._connected or not self._redis:
            return []
        try:
            raw_map = await self._redis.hgetall(REDIS_KEY_ACTIVE)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry list_all failed: %s", exc)
            return []
        out: list[dict] = []
        for raw in raw_map.values():
            try:
                out.append(json.loads(raw))
            except Exception:  # noqa: BLE001
                continue
        return out

    async def count(self) -> int:
        if not self._connected or not self._redis:
            return 0
        try:
            return int(await self._redis.hlen(REDIS_KEY_ACTIVE))
        except Exception:  # noqa: BLE001
            return 0

    async def save_provider_config(self, org_key: str, config: dict) -> None:
        """Persist a per-org provider config so it survives pod restarts (D-5).

        Best-effort like every other registry op: when Redis is down the
        in-memory cache in api.py still works for this pod's lifetime.
        """
        if not self._connected or not self._redis:
            return
        try:
            await self._redis.hset(
                REDIS_KEY_PROVIDER_CONFIG, org_key, json.dumps(config, default=str)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry save_provider_config(%s) failed: %s", org_key, exc)

    async def load_provider_config(self, org_key: str) -> Optional[dict]:
        """Read a persisted per-org provider config, or None when absent."""
        if not self._connected or not self._redis:
            return None
        try:
            raw = await self._redis.hget(REDIS_KEY_PROVIDER_CONFIG, org_key)
            if raw:
                return json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry load_provider_config(%s) failed: %s", org_key, exc)
        return None

    async def reconcile_orphans(self) -> list[dict]:
        """On service startup: read every entry in the registry, return
        them, and clear the hash. Caller is responsible for asking
        LiveKit to remove the now-orphaned participants from their rooms.
        Returns the list of orphans so the caller can act on them."""
        if not self._connected or not self._redis:
            return []
        try:
            raw_map = await self._redis.hgetall(REDIS_KEY_ACTIVE)
            if not raw_map:
                return []
            orphans: list[dict] = []
            for raw in raw_map.values():
                try:
                    orphans.append(json.loads(raw))
                except Exception:  # noqa: BLE001
                    continue
            # Wipe the prior-pod state. Subsequent register() calls
            # repopulate. Doing this BEFORE the LiveKit cleanup so two
            # replicas booting concurrently don't both try to reconcile
            # the same orphans.
            await self._redis.delete(REDIS_KEY_ACTIVE)
            return orphans
        except Exception as exc:  # noqa: BLE001
            logger.warning("Registry reconcile_orphans failed: %s", exc)
            return []


def _scrub_url(url: str) -> str:
    """Hide the password component of a Redis URL for log lines."""
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        if "@" in rest:
            _, host = rest.split("@", 1)
            return f"{scheme}://***@{host}"
    return url
