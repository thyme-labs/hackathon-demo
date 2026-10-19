import { FlaskConical, Plus, Upload } from 'lucide-react'
import { useState } from 'react'
import { UploadDialog, type UploadTab } from '@/components/invoices/UploadDialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface UploadButtonProps {
  /** Button text. */
  label?: string
  icon?: 'upload' | 'plus' | 'flask'
  variant?: 'default' | 'secondary' | 'ghost'
  /** Tab the dialog opens on. */
  tab?: UploadTab
  className?: string
}

const ICONS = { upload: Upload, plus: Plus, flask: FlaskConical } as const

/** Opens the upload dialog (drag-and-drop PDFs or demo invoices). Used on /invoices and as "New invoice" on the dashboard. */
export function UploadButton({ label = 'Upload', icon = 'upload', variant = 'secondary', tab = 'upload', className }: UploadButtonProps) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[icon]

  function handleOpen() {
    setOpen(true)
  }

  return (
    <>
      <Button variant={variant} onClick={handleOpen} className={cn(variant === 'ghost' && 'text-dim', className)}>
        <Icon aria-hidden />
        {label}
      </Button>
      {open ? <UploadDialog open={open} onOpenChange={setOpen} defaultTab={tab} /> : null}
    </>
  )
}
