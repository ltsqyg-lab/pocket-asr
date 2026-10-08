// Text clean-up shared by all engines: trim, collapse whitespace, and drop the spaces some engines put between Chinese
// characters ("你 好" → "你好") while keeping the space between Chinese and Latin words ("把 README 翻译").

const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'
const BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g')

export function tidyText(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/\s+/g, ' ').replace(BETWEEN_CJK, '$1').trim()
}

/** Characters as a person counts them (for the log line: a number, never the text). */
export const charCount = (s) => [...(s || '')].length
