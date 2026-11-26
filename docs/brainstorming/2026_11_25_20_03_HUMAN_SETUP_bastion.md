# Bastion: human actions (cycle 2026_11_25_20_03)

This file lists only actions a person has to take. Everything else in the Bastion build is engineered and verified on the `suite-brainstorm` branch by the autonomous cycle. Check an item off when it is done.

## 1. Local Docker host: the Docker Desktop VM disk is extremely slow (environment, not code)

- [ ] **What:** Docker Desktop's data disk (`C:\Users\eoffe\AppData\Local\Docker\wsl\disk\docker_data.vhdx`, 1.7 TB used of 2.0 TB inside the VM) is writing at about 0.35 MB/s with roughly 265 ms per write (measured 2026-11-26 01:15 from `/proc/diskstats` in the `docker-desktop` WSL distro). A single image's final `RUN chown -R` step took over 80 minutes, a 30-image parallel rebuild stalled at 0 steps for 108 minutes, and the default `desktop-linux` BuildKit wedged so that even a two-line Dockerfile hung.
- **Why it matters:** rebuilding the whole BigBlueBam stack locally is impractical (days). The autonomous cycle worked around it by building only the images Bastion needs, one at a time, on an isolated `bbam-builder` docker-container builder (`BUILDX_BUILDER=bbam-builder`), and starting every other service on its existing image. Other projects sharing this Docker Desktop (b2c3d, b2cConvoGen, b2cPayments, FrndoVoiceBench) are affected too.
- **Why the cycle did not do it:** the fixes require stopping Docker Desktop, which would take down other projects' running stacks.
- **How (pick what fits):**
  1. Reclaim space and compact: `docker builder prune -a` and `docker image prune -a` for unused images (check other projects first), then Docker Desktop > Settings > Resources > "Clean / Purge data" is NOT what you want (it wipes volumes); instead quit Docker Desktop and run, in an elevated PowerShell: `wsl --shutdown` then `Optimize-VHD -Path "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx" -Mode Full` (Hyper-V module) or `diskpart` `compact vdisk`.
  2. Or move the disk image to a faster drive: Docker Desktop > Settings > Resources > Advanced > "Disk image location".
  3. Check the C: drive's health (SMART) given the H: drive failure on 2026-11-04.
- **Verify:** `wsl -d docker-desktop -- sh -c "cat /proc/diskstats | grep ' sdd '; sleep 10; cat /proc/diskstats | grep ' sdd '"` should show far more than 30 writes per 10 s at well under 50 ms each; `cd V:\github\BigBlueBam-autonomous; docker compose build api` should finish in minutes.
- **Afterwards:** the isolated builder can be removed with `docker buildx rm bbam-builder`.

## 2. Standing note: promotion is the maintainer's decision

- [ ] Everything in this cycle lives on `suite-brainstorm`. Promoting it to `main` and then `stable` (which triggers the Railway deploy) is a human decision outside the autonomous loop.
- **After promotion, verify on Railway staging** (the spec's M9 Railway smoke test, which needs a Railway deploy this loop does not perform): build and download one Bastion audit packet; confirm the first `bastion-evaluate-tick` log line on the worker and `GET /bastion/api/health` through the ingress; confirm the worker received `BASTION_S3_BUCKET` and `BASTION_API_INTERNAL_URL` via the scoped variable propagation (#126).
- **Also check on promotion:** banter-api on Railway must have `S3_ACCESS_KEY` and `S3_SECRET_KEY` set (the `minioadmin` fallbacks were removed in #159; without them Banter file routes return 503).

## External credentials

None so far. (Updated as later milestones reach any code path that needs a third-party key, such as a live LLM provider for compile tailoring and questionnaire autofill.)
