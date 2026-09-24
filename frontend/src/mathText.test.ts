import { describe, expect, it } from 'vitest'

import { normalizeMath } from './mathText'

describe('normalizeMath', () => {
  it('leaves dollar-delimited maths and plain text alone', () => {
    const text = 'Solve $px+qy=3z$. The sol is $\\phi(\\frac{x}{y})=0$ for 5 marks.'

    expect(normalizeMath(text)).toBe(text)
  })

  it('turns \\( ... \\) into inline maths', () => {
    expect(normalizeMath('Let \\( a_n = 0 \\) here.')).toBe('Let $a_n = 0$ here.')
  })

  it('turns \\[ ... \\] into a display block', () => {
    expect(normalizeMath('Hence \\[ y = \\frac{1}{2} \\] done')).toBe('Hence \n$$\ny = \\frac{1}{2}\n$$\n done')
  })

  it('makes a line holding only $$ ... $$ a display block', () => {
    expect(normalizeMath('Given\n$$\\int_0^1 x\\,dx$$\nso')).toBe('Given\n$$\n\\int_0^1 x\\,dx\n$$\nso')
  })

  it('keeps LaTeX line breaks such as \\\\[2pt] intact', () => {
    const text = '$$\\begin{aligned} a &= b \\\\[2pt] c &= d \\end{aligned}$$ and more'

    expect(normalizeMath(text)).toBe(text)
  })
})
