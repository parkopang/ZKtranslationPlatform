import { useEffect, useRef } from 'react'
import { createPoller, type PollContext } from './polling'

export function useLiveSync(enabled: boolean, run: (context: PollContext) => Promise<void>, scope = '') {
  const callback = useRef(run)
  callback.current = run
  const poller = useRef<ReturnType<typeof createPoller> | null>(null)
  useEffect(() => {
    if (!enabled) return
    const next = createPoller((context) => callback.current(context), {
      visible: () => !document.hidden, online: () => navigator.onLine !== false,
      setTimer: (callback, delay) => window.setTimeout(callback, delay), clearTimer: (timer) => window.clearTimeout(timer as number),
      subscribe: (wake) => {
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake)
        return () => { document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake) }
      },
    })
    poller.current = next
    return () => { next.stop(); if (poller.current === next) poller.current = null }
  }, [enabled, scope])
  return {
    refresh: () => poller.current?.refresh(), invalidate: () => poller.current?.invalidate(),
    pause: () => poller.current?.pause(), resume: () => poller.current?.resume(),
  }
}
