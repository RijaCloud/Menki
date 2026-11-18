// A deterministic reading version: the original conversation remains untouched.
export function spokenText(source: string, culture = 'fr-FR', limit = 3000) {
  const french = culture === 'fr-FR';
  const link = french ? 'lien disponible à l’écran' : 'link available on screen';
  const code = french ? 'Code disponible à l’écran.' : 'Code available on screen.';
  let text = source
    .replace(/^\s*REVIEW_(?:APPROVED|CHANGES)\s*$/gm, '')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, code)
    .replace(/!\[([^\]]*)\]\([^\n]*?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/gi, link)
    .replace(
      /\b[A-Z]:[\\/][^\s<>"`]+/gi,
      (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
    )
    .replace(
      /(?:\.{0,2}\/|\\\\)[\w.@~+-]+(?:[\\/][\w.@~+-]+)+/g,
      (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
    )
    .replace(
      /\b[\w.@~-]+(?:\/[\w.@~-]+)+\.[a-z0-9]{1,8}\b/gi,
      (path) => path.split('/').at(-1) ?? '',
    )
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, french ? ' et ' : ' and ')
    .replace(/&(?:lt|gt|quot|nbsp);/g, ' ')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\[[^\]]+\]:.*$/gm, '')
    .replace(/[*_`#|~]/g, ' ')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1 ' + (french ? 'sur' : 'out of') + ' $2')
    .replace(/[\\/]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  if (text.length > limit) {
    const shortened = text.slice(0, limit);
    text =
      shortened.slice(0, Math.max(shortened.lastIndexOf(' '), limit - 80)).trimEnd() +
      (french ? '… La suite est disponible à l’écran.' : '… The rest is available on screen.');
  }
  return text;
}
