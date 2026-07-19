/**
 * Burn SPA root. M1 ships the scaffold only; the seven screens (Portfolio Board, Unscoped
 * Queue, engagement detail, Gate Console, variance and change-order inbox, cost rates,
 * settings and rules) plus full shell parity land in M7.
 */
export function App() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">Burn</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Contract consumption, unscoped work, and the pre-transaction gate.
        </p>
      </div>
    </div>
  );
}
