import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LoaderCircle, Upload } from 'lucide-react'
import { type ChangeEvent, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

async function uploadPdf(file: File): Promise<{ id: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/invoices/upload', { method: 'POST', body: form })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `upload failed (${res.status})`)
  }
  return (await res.json()) as { id: string }
}

/** "Upload PDF" button: posts to /api/invoices/upload and selects the new invoice. */
export function UploadButton() {
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const upload = useMutation({
    mutationFn: uploadPdf,
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await navigate({ to: '/invoices', search: { id } })
      toast.success('Invoice queued')
    },
    onError: (error) => toast.error(error.message),
  })

  function handlePick() {
    inputRef.current?.click()
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) upload.mutate(file)
  }

  return (
    <>
      <Input ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={handleChange} aria-label="Invoice PDF" />
      <Button variant="secondary" onClick={handlePick} disabled={upload.isPending}>
        {upload.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Upload aria-hidden />}
        Upload
      </Button>
    </>
  )
}
