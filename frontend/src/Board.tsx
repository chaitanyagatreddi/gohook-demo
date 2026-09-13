import { useState } from 'react'

export type BoardColumn = 'new' | 'reviewing' | 'actioned'

export type BoardCard = {
  id: string
  title?: string
  text: string
  source_url: string
  subreddit: string
  reddit_score: number
  category?: string
  origin?: string
  column: BoardColumn
}

const COLUMNS: { key: BoardColumn; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'actioned', label: 'Actioned' },
]

const ORIGIN_BADGE: Record<string, string> = {
  pricing: 'bg-[#50c878]/15 text-[#50c878]',
  complaints: 'bg-[#ff4500]/15 text-[#ff6a33]',
  comparisons: 'bg-[#7a9bff]/15 text-[#7a9bff]',
  praise: 'bg-[#e879f9]/15 text-[#e879f9]',
  quotes: 'bg-[#9aa4b2]/15 text-[#9aa4b2]',
  question: 'bg-[#ffb020]/15 text-[#ffb020]',
}

export default function Board({
  board,
  setBoard,
  onGoToResults,
}: {
  board: BoardCard[]
  setBoard: (updater: (prev: BoardCard[]) => BoardCard[]) => void
  onGoToResults?: () => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<BoardColumn | null>(null)

  function moveCard(id: string, column: BoardColumn) {
    setBoard(prev => prev.map(c => (c.id === id ? { ...c, column } : c)))
  }

  function removeCard(id: string) {
    setBoard(prev => prev.filter(c => c.id !== id))
  }

  if (board.length === 0) {
    return (
      <div className="mt-2 text-center py-16 border border-dashed border-[#30333a] bg-[#101114] rounded-xl">
        <p className="text-[#9aa4b2] text-sm">No signals on the board yet.</p>
        <p className="text-[#6b7280] text-xs mt-1">
          Scan a product, then hit <button onClick={onGoToResults} className="text-[#ff6a33] hover:underline">+ Board</button> on any result to triage it here.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
      {COLUMNS.map(col => {
        const cards = board.filter(c => c.column === col.key)
        return (
          <div
            key={col.key}
            onDragOver={e => { e.preventDefault(); setOverCol(col.key) }}
            onDragLeave={() => setOverCol(c => (c === col.key ? null : c))}
            onDrop={() => {
              if (dragId) moveCard(dragId, col.key)
              setDragId(null)
              setOverCol(null)
            }}
            className={`rounded-xl border p-4 min-h-[560px] transition-colors ${
              overCol === col.key ? 'border-[#ff6a33] bg-[#ff6a33]/5' : 'border-[#2a2d33] bg-[#121417] shadow-[0_12px_30px_rgba(0,0,0,0.12)]'
            }`}
          >
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#25282e]">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#858b95]">
                {col.label}
              </h4>
              <span className="text-[11px] bg-[#0d0f12] border border-[#292c32] text-[#9aa4b2] rounded-full px-2 py-0.5 tabular-nums">
                {cards.length}
              </span>
            </div>

            <div className="space-y-3">
              {cards.map(card => (
                <div
                  key={card.id}
                  draggable
                  onDragStart={() => setDragId(card.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null) }}
                  className={`group rounded-xl border border-[#2a2d33] bg-[#0d0f12] p-4 cursor-grab active:cursor-grabbing shadow-[0_8px_18px_rgba(0,0,0,0.16)] transition-colors hover:border-[#3b3f47] ${
                    dragId === card.id ? 'opacity-50' : ''
                  }`}
                >
                  {card.title && <p className="text-sm font-semibold text-[#e8eaed] mb-1.5 leading-snug">{card.title}</p>}
                  <p className="text-[13px] text-[#d7dbe1] leading-relaxed line-clamp-4">{card.text}</p>
                  <div className="mt-3 flex items-center gap-2 text-[11px] text-[#9aa4b2]">
                    <span>{card.subreddit}</span>
                    {card.reddit_score > 0 && <span>▲ {card.reddit_score}</span>}
                    {card.origin && (
                      <span className={`px-1.5 py-0.5 rounded ${ORIGIN_BADGE[card.origin] || 'bg-[#242a33] text-[#9aa4b2]'}`}>
                        {card.origin}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-[11px]">
                    <a
                      href={card.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#ff6a33] hover:underline"
                    >
                      view →
                    </a>
                    <button
                      onClick={() => removeCard(card.id)}
                      className="ml-auto text-[#6b7280] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove from board"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
