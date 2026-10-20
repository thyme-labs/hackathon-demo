import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, FileText, FlaskConical, LoaderCircle, TriangleAlert, Upload } from 'lucide-react'
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { DemoInvoiceList } from '@/components/invoices/DemoDrawer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type UploadTab = 'upload' | 'demo'

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tab shown when the dialog opens. */
  defaultTab?: UploadTab
}

type FileStatus = 'waiting' | 'uploading' | 'done' | 'error'

interface FileEntry {
  key: string
  file: File
  status: FileStatus
  /** 0..100 upload progress. */
  progress: number
  id: string | null
  error: string | null
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
/** Amazon Bedrock accepts images up to 3.75 MB; the server refuses larger ones, so say so before uploading. */
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024)
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain'
const ACCEPTED_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain'])
const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g|txt)$/i
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg'])
const IMAGE_EXTENSIONS = /\.(png|jpe?g)$/i

function validate(file: File): string | null {
  const accepted = ACCEPTED_MIMES.has(file.type) || ACCEPTED_EXTENSIONS.test(file.name)
  if (!accepted) return 'only .pdf, .png, .jpg and .txt files are accepted'
  if (file.size === 0) return 'the file is empty'
  if (file.size > MAX_UPLOAD_BYTES) return `larger than 10 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)`
  const isImage = IMAGE_MIMES.has(file.type) || IMAGE_EXTENSIONS.test(file.name)
  if (isImage && file.size > MAX_IMAGE_BYTES) return `images are limited to 3.75 MB by Amazon Bedrock (${(file.size / 1024 / 1024).toFixed(1)} MB)`
  return null
}

/** POST /api/invoices/upload with upload progress (fetch has no progress events). */
function uploadWithProgress(file: File, onProgress: (pct: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/invoices/upload')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      let body: { id?: string; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText) as { id?: string; error?: string }
      } catch {
        body = {}
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve({ id: body.id })
      else reject(new Error(body.error ?? `upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('network error'))
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

const formatSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/**
 * "New invoice" / "Upload": drag-and-drop zone for one or more invoice files (PDF, PNG, JPEG or TXT; 10 MB each), a file picker, a per-file progress
 * list, and a second tab with the demo invoices. After the uploads finish the first new invoice is selected.
 */
export function UploadDialog({ open, onOpenChange, defaultTab = 'upload' }: UploadDialogProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<UploadTab>(defaultTab)

  const patch = (key: string, next: Partial<FileEntry>) => {
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...next } : e)))
  }

  async function uploadAll(fresh: FileEntry[]) {
    setBusy(true)
    let firstId: string | null = null
    let okCount = 0
    for (const entry of fresh) {
      if (entry.status === 'error') continue
      patch(entry.key, { status: 'uploading', progress: 0 })
      try {
        const { id } = await uploadWithProgress(entry.file, (pct) => patch(entry.key, { progress: pct }))
        patch(entry.key, { status: 'done', progress: 100, id })
        firstId = firstId ?? id
        okCount += 1
      } catch (error) {
        patch(entry.key, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
    setBusy(false)
    await queryClient.invalidateQueries({ queryKey: ['invoices'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    if (firstId) {
      toast.success(okCount === 1 ? 'Invoice queued' : `${okCount} invoices queued`)
      onOpenChange(false)
      await navigate({ to: '/invoices', search: { id: firstId } })
    }
  }

  function addFiles(files: FileList | File[]) {
    const fresh: FileEntry[] = Array.from(files).map((file) => {
      const error = validate(file)
      return { key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, file, status: error ? 'error' : 'waiting', progress: 0, id: null, error }
    })
    if (fresh.length === 0) return
    setEntries((list) => [...list, ...fresh])
    void uploadAll(fresh)
  }

  function handlePick() {
    inputRef.current?.click()
  }
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    // Copy the live FileList before resetting the input (resetting empties it).
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) addFiles(files)
  }
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (!dragging) setDragging(true)
  }
  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
  }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length > 0) addFiles(files)
  }
  function handleOpenChange(next: boolean) {
    if (!next && busy) return
    if (!next) setEntries([])
    onOpenChange(next)
  }
  function handleTabChange(value: string) {
    setTab(value === 'demo' ? 'demo' : 'upload')
  }
  async function handleDemoQueued(id: string) {
    onOpenChange(false)
    await navigate({ to: '/invoices', search: { id } })
  }
  function handleClear() {
    setEntries((list) => list.filter((e) => e.status === 'uploading'))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg bg-popover">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>Drop contractor invoices as PDF, PNG, JPEG or plain text. The agent reads each one, runs the checks and pays in EURC when every rule is green.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="bg-raised">
            <TabsTrigger value="upload">
              <Upload aria-hidden />
              Upload files
            </TabsTrigger>
            <TabsTrigger value="demo">
              <FlaskConical aria-hidden />
              Demo invoices
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="mt-3 grid gap-3">
            <div
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={cn(
                'grid place-items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors',
                dragging ? 'border-sage bg-sage/10' : 'border-hairline bg-surface',
              )}
              aria-label="Drop invoice files here"
            >
              <Upload aria-hidden className={cn('size-6', dragging ? 'text-sage' : 'text-dim')} strokeWidth={1.5} />
              <div className="text-sm">{dragging ? 'Release to upload' : 'Drag & drop invoices here'}</div>
              <div className="text-xs text-dim">.pdf, .png, .jpg, .txt · up to 10 MB each · several at once</div>
              <Input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={handleChange} aria-label="Invoice files" />
              <Button type="button" variant="secondary" size="sm" onClick={handlePick} disabled={busy} className="mt-2">
                <FileText aria-hidden />
                Choose files
              </Button>
            </div>
            {entries.length > 0 ? (
              <ul className="grid gap-2" aria-label="Upload progress">
                {entries.map((entry) => (
                  <li key={entry.key} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs">
                    {entry.status === 'done' ? (
                      <Check aria-hidden className="size-4 text-sage" />
                    ) : entry.status === 'error' ? (
                      <TriangleAlert aria-hidden className="size-4 text-blocked" />
                    ) : entry.status === 'uploading' ? (
                      <LoaderCircle aria-hidden className="size-4 animate-spin text-sage" />
                    ) : (
                      <FileText aria-hidden className="size-4 text-dim" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-mono" title={entry.file.name}>
                        {entry.file.name}
                      </div>
                      {entry.status === 'error' ? (
                        <div className="text-blocked">{entry.error}</div>
                      ) : (
                        <Progress value={entry.progress} className="mt-1.5 h-1 bg-track" aria-label={`${entry.file.name} ${entry.progress}%`} />
                      )}
                    </div>
                    <div className="text-right font-mono text-dim">
                      {entry.status === 'done' ? 'queued' : entry.status === 'uploading' ? `${entry.progress}%` : entry.status === 'error' ? 'skipped' : formatSize(entry.file.size)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <DialogFooter className="sm:justify-between">
              <span className="self-center text-xs text-dim">{busy ? 'Uploading…' : entries.some((e) => e.status === 'error') ? 'Fix the files marked red and drop them again.' : ''}</span>
              <div className="flex gap-2">
                {entries.length > 0 && !busy ? (
                  <Button type="button" variant="ghost" className="text-dim" onClick={handleClear}>
                    Clear
                  </Button>
                ) : null}
                <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} disabled={busy}>
                  Close
                </Button>
              </div>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="demo" className="mt-3">
            <div className="text-xs text-dim">Synthetic PDFs from demo/invoices. One click queues the file for the agent.</div>
            <DemoInvoiceList enabled={open && tab === 'demo'} onQueued={handleDemoQueued} className="mt-2 max-h-80 overflow-y-auto" />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
