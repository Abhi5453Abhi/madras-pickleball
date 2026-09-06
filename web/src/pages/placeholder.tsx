/** Stands in for a page that has not been ported yet. */
export function Placeholder({ name }: { name: string }) {
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-title">{name}</h1>
      <p className="text-row text-text-2">This screen has not been built yet.</p>
    </main>
  )
}
