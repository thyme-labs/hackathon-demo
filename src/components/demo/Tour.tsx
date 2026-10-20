import { useLocation, useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, ExternalLink, Sparkles, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TOUR_STEPS } from '@/lib/demo/steps'
import { tourStore, useTour } from '@/lib/demo/tourStore'
import type { JuryDemoState } from '@/lib/server/demo.fns'
import { cn } from '@/lib/utils'

interface TourProps {
  /** From the root loader: demoMode of the tenant and the seeded anchors. */
  demo: JuryDemoState
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

/** Spotlight padding around the target, card width (w-84 = 21rem) and the gap between target and card. */
const PAD = 8
const CARD_W = 336
const GAP = 14
const EDGE = 12
/** How long to wait for a target to appear (data loads async) before showing the card centred. */
const FIND_TIMEOUT_MS = 2500
const POLL_MS = 150

const sameRect = (a: Rect | null, b: Rect): boolean => a !== null && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5

/**
 * The card carries aria-live so Radix modals (Send anyway, the beneficiary sheet) leave it in the accessibility
 * tree and clickable while they are open; clicking Next outside them also dismisses them.
 *
 * Guided walkthrough for the jury demo tenant (settings.demoMode). Mounted once in the root; shows only when the
 * tenant is a demo and the tour is active (sessionStorage, or ?tour=1 on the dashboard). No dependencies: a
 * four-rectangle dim layer around the target's bounding box, the page stays clickable underneath.
 */
export function Tour({ demo }: TourProps) {
  const { active, step } = useTour()
  const router = useRouter()
  const { pathname } = useLocation()
  const search = useSearch({ strict: false }) as { tour?: unknown; id?: unknown }
  const [hydrated, setHydrated] = useState(false)
  const tourFlag = search.tour !== undefined && search.tour !== null

  useEffect(() => {
    tourStore.hydrate()
    setHydrated(true)
  }, [])

  // ?tour=1 (set by "Jury demo") starts from the first step; the flag is dropped from the URL right away.
  useEffect(() => {
    if (!hydrated || !demo.mode || !tourFlag) return
    tourStore.start(0)
    void router.navigate({ to: '/dashboard', search: {}, replace: true })
  }, [hydrated, demo.mode, tourFlag, router])

  if (!hydrated || !demo.mode || !active) return null
  const index = Math.min(step, TOUR_STEPS.length - 1)
  return <TourOverlay key={index} index={index} demo={demo} pathname={pathname} selectedId={typeof search.id === 'string' ? search.id : null} />
}

interface TourOverlayProps {
  index: number
  demo: JuryDemoState
  pathname: string
  selectedId: string | null
}

function TourOverlay({ index, demo, pathname, selectedId }: TourOverlayProps) {
  const router = useRouter()
  const current = TOUR_STEPS[index]
  const total = TOUR_STEPS.length
  const last = index === total - 1
  const wantId = current.invoice ? (demo.invoices[current.invoice] ?? null) : null
  const onRoute = pathname === current.route && (!wantId || selectedId === wantId)
  const [rect, setRect] = useState<Rect | null>(null)
  const [missing, setMissing] = useState(!current.target)
  const [href, setHref] = useState<string | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<Rect | null>(null)

  // 1. Be on the step's page (and invoice).
  useEffect(() => {
    if (onRoute) return
    const target = wantId ? `${current.route}?id=${encodeURIComponent(wantId)}` : current.route
    void router.navigate({ href: target })
  }, [onRoute, wantId, current.route, router])

  // 2. Open what the step needs, find the target, keep its box fresh (data loads async, layout shifts).
  useEffect(() => {
    if (!onRoute) return
    let clicked = false
    let scrolled = false
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      if (current.clickOnEnter && !clicked) {
        const trigger = document.querySelector<HTMLElement>(`[data-tour="${current.clickOnEnter}"]`)
        if (trigger) {
          clicked = true
          trigger.click()
        }
      }
      const el = current.target ? document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`) : null
      if (el) {
        if (!scrolled) {
          scrolled = true
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        const r = el.getBoundingClientRect()
        const next = { top: r.top, left: r.left, width: r.width, height: r.height }
        if (!sameRect(rectRef.current, next)) {
          rectRef.current = next
          setRect(next)
        }
        setMissing(false)
        setHref(current.openLink && el instanceof HTMLAnchorElement ? el.href : null)
      } else if (!current.target || Date.now() - startedAt > FIND_TIMEOUT_MS) {
        rectRef.current = null
        setRect(null)
        setMissing(true)
      }
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      if (timer) clearTimeout(timer)
      if (current.dismissOnLeave) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
  }, [onRoute, current])

  // 3. Geometry goes into CSS variables on the frame and the card (no inline style props).
  useLayoutEffect(() => {
    const frame = frameRef.current
    const card = cardRef.current
    if (!frame || !card) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cardH = card.offsetHeight
    if (rect && !missing) {
      const top = Math.max(0, rect.top - PAD)
      const left = Math.max(0, rect.left - PAD)
      const right = Math.min(vw, rect.left + rect.width + PAD)
      const bottom = Math.min(vh, rect.top + rect.height + PAD)
      frame.style.setProperty('--tour-top', `${top}px`)
      frame.style.setProperty('--tour-left', `${left}px`)
      frame.style.setProperty('--tour-right', `${right}px`)
      frame.style.setProperty('--tour-bottom', `${bottom}px`)
      frame.style.setProperty('--tour-w', `${Math.max(0, right - left)}px`)
      frame.style.setProperty('--tour-h', `${Math.max(0, bottom - top)}px`)
      let cardTop = bottom + GAP
      let cardLeft = left
      if (cardTop + cardH > vh - EDGE) cardTop = top - GAP - cardH
      if (cardTop < EDGE) {
        // Target fills the height: sit beside it.
        cardTop = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - cardH - EDGE))
        cardLeft = right + GAP
        if (cardLeft + CARD_W > vw - EDGE) cardLeft = left - GAP - CARD_W
      }
      cardLeft = Math.min(Math.max(EDGE, cardLeft), Math.max(EDGE, vw - CARD_W - EDGE))
      card.style.setProperty('--tour-card-top', `${cardTop}px`)
      card.style.setProperty('--tour-card-left', `${cardLeft}px`)
    } else {
      card.style.setProperty('--tour-card-top', `${Math.max(EDGE, (vh - cardH) / 2)}px`)
      card.style.setProperty('--tour-card-left', `${Math.max(EDGE, (vw - CARD_W) / 2)}px`)
    }
  }, [rect, missing])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'ArrowRight') handleNext()
      if (event.key === 'ArrowLeft') handleBack()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  function handleNext() {
    if (last) tourStore.stop()
    else tourStore.go(index + 1)
  }
  function handleBack() {
    if (index > 0) tourStore.go(index - 1)
  }
  function handleSkip() {
    tourStore.stop()
  }
  function handleRestart() {
    tourStore.go(0)
  }
  function handleOpen() {
    if (href) window.open(href, '_blank', 'noopener')
  }

  const spotlight = rect !== null && !missing

  return (
    <>
      <div ref={frameRef} aria-hidden className="pointer-events-none fixed inset-0 z-60">
        {spotlight ? (
          <>
            <div className="fixed inset-x-0 top-0 h-(--tour-top) bg-bg/70 transition-all duration-300" />
            <div className="fixed inset-x-0 bottom-0 top-(--tour-bottom) bg-bg/70 transition-all duration-300" />
            <div className="fixed top-(--tour-top) left-0 h-(--tour-h) w-(--tour-left) bg-bg/70 transition-all duration-300" />
            <div className="fixed top-(--tour-top) right-0 left-(--tour-right) h-(--tour-h) bg-bg/70 transition-all duration-300" />
            <div className="fixed top-(--tour-top) left-(--tour-left) h-(--tour-h) w-(--tour-w) rounded-xl ring-1 ring-sage/70 transition-all duration-300" />
          </>
        ) : (
          <div className="fixed inset-0 bg-bg/70" />
        )}
      </div>
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`Guided tour, step ${index + 1} of ${total}`}
        aria-live="polite"
        data-tour-card
        className={cn('pointer-events-auto fixed top-(--tour-card-top) left-(--tour-card-left) z-60 w-84 rounded-xl border border-hairline bg-popover p-5 shadow-2xl transition-all duration-300', last && 'w-96')}
      >
        <div className="flex items-center justify-between text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <Sparkles aria-hidden className="size-3 text-sage" />
            Jury demo · {index + 1}/{total}
          </span>
          <Button variant="ghost" size="icon-xs" className="-mr-1.5 text-dim" onClick={handleSkip} aria-label="Skip the tour" title="Skip">
            <X aria-hidden />
          </Button>
        </div>
        <h2 className={cn('mt-3 font-medium tracking-tightest', last ? 'text-xl' : 'text-base')}>{current.title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-secondary-foreground">{current.text}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {href ? (
              <Button variant="ghost" size="sm" className="text-dim" onClick={handleOpen}>
                Open
                <ExternalLink aria-hidden />
              </Button>
            ) : null}
            {last ? (
              <Button variant="ghost" size="sm" className="text-dim" onClick={handleRestart}>
                Restart
              </Button>
            ) : null}
          </div>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" className="text-dim" onClick={handleBack} disabled={index === 0}>
              <ChevronLeft aria-hidden />
              Back
            </Button>
            <Button size="sm" onClick={handleNext} autoFocus>
              {last ? 'Finish' : 'Next'}
              {last ? null : <ChevronRight aria-hidden />}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
