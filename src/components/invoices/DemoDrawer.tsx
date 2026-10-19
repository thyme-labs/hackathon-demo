import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FlaskConical, LoaderCircle, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { enqueueDemoInvoice, listDemoInvoices } from '@/lib/server/invoices.fns'

/** Drawer listing demo/invoices/*.pdf with one-click enqueue. */
export function DemoDrawer() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const demo = useQuery({ queryKey: ['demo-invoices'], queryFn: () => listDemoInvoices(), enabled: open })
  const enqueue = useMutation({
    mutationFn: (file: string) => enqueueDemoInvoice({ data: { file } }),
    onSuccess: async ({ id }, file) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setOpen(false)
      await navigate({ to: '/invoices', search: { id } })
      toast.success(`${file.slice(0, 8)} queued`)
    },
    onError: (error) => toast.error(error.message),
  })

  function handleEnqueue(file: string) {
    enqueue.mutate(file)
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
        <div className="grid gap-1 px-4 pb-6">
          {demo.isLoading ? <div className="text-xs text-dim">Loading…</div> : null}
          {demo.data?.map((item) => {
            const fraud = item.number === 'INV-0432' || item.number === 'INV-0440'
            const pending = enqueue.isPending && enqueue.variables === item.file
            return (
              <button
                type="button"
                key={item.file}
                onClick={() => handleEnqueue(item.file)}
                disabled={enqueue.isPending}
                className={cn('flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-raised disabled:opacity-60')}
              >
                <div className="min-w-0 flex-1">
                  <div className={cn('font-mono text-sm', fraud && 'text-blocked')}>{item.number}</div>
                  <div className="truncate text-xs text-dim">{item.hint}</div>
                </div>
                {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin text-dim" /> : <Plus aria-hidden className="size-4 text-dim" />}
              </button>
            )
          })}
          {demo.data && demo.data.length === 0 ? <div className="text-xs text-dim">No demo PDFs found. Run `bun demo/make-invoices.ts`.</div> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
