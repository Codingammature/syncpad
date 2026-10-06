const BUTTONS = [
  { label: 'Bold', text: 'B', cls: 'b', run: (c) => c.toggleBold(), active: 'bold' },
  { label: 'Italic', text: 'I', cls: 'i', run: (c) => c.toggleItalic(), active: 'italic' },
  { label: 'Strikethrough', text: 'S', cls: 's', run: (c) => c.toggleStrike(), active: 'strike' },
  { sep: true },
  { label: 'Heading 1', text: 'H1', run: (c) => c.toggleHeading({ level: 1 }), active: ['heading', { level: 1 }] },
  { label: 'Heading 2', text: 'H2', run: (c) => c.toggleHeading({ level: 2 }), active: ['heading', { level: 2 }] },
  { sep: true },
  { label: 'Bulleted list', text: 'List', run: (c) => c.toggleBulletList(), active: 'bulletList' },
  { label: 'Numbered list', text: '1. 2.', run: (c) => c.toggleOrderedList(), active: 'orderedList' },
  { label: 'Quote', text: 'Quote', run: (c) => c.toggleBlockquote(), active: 'blockquote' },
  { label: 'Code block', text: 'Code', run: (c) => c.toggleCodeBlock(), active: 'codeBlock' },
  { sep: true },
  { label: 'Undo', text: 'Undo', run: (c) => c.undo() },
  { label: 'Redo', text: 'Redo', run: (c) => c.redo() },
]

export default function Toolbar({ editor }) {
  if (!editor) return null
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {BUTTONS.map((b, i) =>
        b.sep ? (
          <span key={i} className="sep" />
        ) : (
          <button
            key={b.label} type="button" title={b.label} aria-label={b.label}
            className={`tb ${b.cls ?? ''} ${b.active && editor.isActive(...[].concat(b.active)) ? 'on' : ''}`}
            onMouseDown={(e) => e.preventDefault()} // keep the editor selection
            onClick={() => b.run(editor.chain().focus()).run()}
          >
            {b.text}
          </button>
        ),
      )}
    </div>
  )
}
