import { Link } from 'react-router'

export function NotFound() {
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-title">There’s nothing here</h1>
      <p className="text-row text-text-2">That address doesn’t go anywhere.</p>
      <Link to="/" className="text-link underline">
        Back to the scores
      </Link>
    </main>
  )
}
