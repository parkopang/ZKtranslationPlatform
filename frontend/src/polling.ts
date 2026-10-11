export type PollContext = { signal: AbortSignal; isCurrent: () => boolean }
export type PollEnvironment = {
  visible: () => boolean; online: () => boolean
  setTimer: (callback: () => void, delay: number) => unknown; clearTimer: (timer: unknown) => void
  subscribe: (wake: () => void) => () => void
}

// One request at a time. A write invalidates earlier reads before it commits.
// Empty/terminal results keep the same bounded schedule as populated results.
export function createPoller(run: (context: PollContext) => Promise<void>, environment: PollEnvironment, interval = 5000) {
  let active = true, running = false, held = false, requested = false
  let generation = 0
  let timer: unknown
  let controller: AbortController | undefined
  const clear = () => { if (timer !== undefined) environment.clearTimer(timer); timer = undefined }
  const available = () => active && !held && environment.visible() && environment.online()
  const schedule = () => { clear(); if (available()) timer = environment.setTimer(() => { timer = undefined; void tick() }, interval) }
  const tick = async () => {
    if (!available()) return
    if (running) { requested = true; return }
    running = true; requested = false; clear()
    const version = generation
    const current = new AbortController(); controller = current
    try { await run({ signal: current.signal, isCurrent: () => active && !current.signal.aborted && generation === version }) }
    catch { /* The consumer owns its error UI; a failure must not stop the loop. */ }
    finally { running = false; if (controller === current) controller = undefined; if (requested && available()) { requested = false; void tick() } else schedule() }
  }
  const invalidate = () => { generation += 1; controller?.abort(); clear() }
  const refresh = () => { invalidate(); requested = true; void tick() }
  const unsubscribe = environment.subscribe(() => {
    if (!environment.visible() || !environment.online()) { invalidate(); return }
    refresh()
  })
  void tick()
  return {
    refresh,
    pause: () => { held = true; requested = false; invalidate() },
    resume: () => { held = false; refresh() },
    invalidate,
    stop: () => { active = false; invalidate(); unsubscribe() },
  }
}
