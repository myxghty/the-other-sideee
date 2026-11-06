// Renders the source document line by line and highlights the line a value came from.
export default function SourceDoc({ lines, highlight, tone = 'red', label }) {
  return (
    <div className="paper" role="figure" aria-label={label || 'Source document'}>
      {lines.map((text, i) => (
        <div
          key={i}
          className={`ln ${i === highlight ? (tone === 'blue' ? 'hl-blue' : 'hl') : ''}`}
          aria-current={i === highlight ? 'true' : undefined}
        >
          <span className="no">{i + 1}</span>
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
