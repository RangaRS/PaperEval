import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  onClick?: () => void
}

/** Where something sits in the college: "Mathematics › B.Sc Mathematics › Semester 3". */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Where this is">
      <ol>
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`}>
            {index > 0 && <ChevronRight size={13} className="breadcrumb-separator" aria-hidden />}
            {item.onClick && index < items.length - 1 ? (
              <button type="button" className="breadcrumb-link" onClick={item.onClick}>
                {item.label}
              </button>
            ) : (
              <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
