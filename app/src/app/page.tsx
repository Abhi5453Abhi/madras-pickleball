import Link from 'next/link'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <p className="text-sm font-semibold tracking-widest text-accent uppercase">
          Madras Pickleball
        </p>
        <h1 className="mt-2 text-3xl font-bold text-ink">Nothing on right now</h1>
        <p className="mt-2 text-muted">
          When a tournament is live you&apos;ll see every court, every score and your next match
          here — no login needed.
        </p>
      </div>
      <Link
        href="/login"
        className="tap-lg flex items-center justify-center rounded-xl bg-ink px-5 font-semibold text-white"
      >
        Organiser sign in
      </Link>
    </main>
  )
}
