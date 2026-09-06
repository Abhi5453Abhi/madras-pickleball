import { requireUser } from '@/lib/auth'
import { Card } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { QuickForm } from './quick-form'

export const metadata = { title: 'Start a tournament · Madras Pickleball' }

export default async function QuickPage() {
  await requireUser('admin')

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-ink">Start a tournament</h1>
        <p className="text-sm text-muted">
          Four taps and a paste. Everything stays editable afterwards.
        </p>
      </div>
      <Card>
        <QuickForm defaultName={`Social — ${venueDate(new Date())}`} />
      </Card>
    </div>
  )
}
