export function countWords(md: string): number {
  const text = md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const tokens = text.split(/\s+/).filter((t) => /[A-Za-z0-9\u00C0-\u024F\u0370-\u1FFF]/.test(t));
  return tokens.length;
}