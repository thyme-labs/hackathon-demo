import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Download, FlaskConical, LoaderCircle, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { enqueueDemoInvoice, listDemoInvoices } from '@/lib/server/invoices.fns'

interface DemoInvoiceListProps {
  /** Called after a demo file was queued (the caller closes its container and navigates). */
  onQueued?: (id: string, file: string) => void | Promise<void>
  /** Only fetch while visible (drawer / dialog tab open). */
  enabled?: boolean
  className?: string
}

/** The list of demo/invoices/*.pdf with one-click enqueue; shared by the drawer and the upload dialog tab. */
export function DemoInvoiceList({ onQueued, enabled = true, className }: DemoInvoiceListProps) {
  const queryClient = useQueryClient()
  const demo = useQuery({ queryKey: ['demo-invoices'], queryFn: () => listDemoInvoices(), enabled })
  const enqueue = useMutation({
    mutationFn: (file: string) => enqueueDemoInvoice({ data: { file } }),
    onSuccess: async ({ id }, file) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await queryClient.invalidateQueries({ queryKey: ['demo-invoices'] })
      toast.success(`${file.slice(0, 8)} queued`)
      await onQueued?.(id, file)
    },
    onError: (error) => toast.error(error.message),
  })

  function handleEnqueue(file: string) {
    enqueue.mutate(file)
  }

  return (
    <div className={cn('grid gap-1', className)}>
      {demo.isLoading ? <div className="px-3 text-xs text-dim">Loading…</div> : null}
      {demo.data?.map((item) => {
        const fraud = item.number === 'INV-0432' || item.number === 'INV-0440'
        const pending = enqueue.isPending && enqueue.variables === item.file
        return (
          <div key={item.file} className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleEnqueue(item.file)}
              disabled={enqueue.isPending}
              className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-lg px-3 py-3 text-left font-normal hover:bg-raised disabled:opacity-60"
            >
              <div className="min-w-0 flex-1">
                <div className={cn('font-mono text-sm', fraud && 'text-blocked')}>
                  {item.number}
                  {item.alreadyQueued ? <span className="ml-2 text-xs text-dim">in queue</span> : null}
                </div>
                <div className="truncate text-xs text-dim">{item.hint}</div>
              </div>
              {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin text-dim" /> : <Plus aria-hidden className="size-4 text-dim" />}
            </Button>
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-dim hover:bg-raised">
              <a href={`/api/demo/invoices/${encodeURIComponent(item.file)}`} download={item.file} aria-label={`Download ${item.number} PDF`}>
                <Download aria-hidden />
              </a>
            </Button>
          </div>
        )
      })}
      {demo.data && demo.data.length === 0 ? <div className="px-3 text-xs text-dim">No demo PDFs found. Run `bun demo/make-invoices.ts`.</div> : null}
    </div>
  )
}

/** Drawer listing demo/invoices/*.pdf with one-click enqueue. */
export function DemoDrawer() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  async function handleQueued(id: string) {
    setOpen(false)
    await navigate({ to: '/invoices', search: { id } })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" className="text-dim">
          <FlaskConical aria-hidden />
          Demo invoices
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-96 bg-surface sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Demo invoices</SheetTitle>
          <SheetDescription>Synthetic PDFs from demo/invoices. One click queues the file for the agent.</SheetDescription>
        </SheetHeader>
        <DemoInvoiceList enabled={open} onQueued={handleQueued} className="px-4 pb-6" />
      </SheetContent>
    </Sheet>
  )
}
