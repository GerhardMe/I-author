// The "what's visible" rule — drafts, notes.md and empty directories — in one
// place, so the sidebar and the pdf aggregates can never silently diverge.
// Pure and DOM-free: safe for both the server and the client bundle.
import { NOTES } from './naming.ts';

// structural subset of the works tree node (works.ts's Node satisfies it)
type VisNode = {
  name: string; // disk name — the notes.md rule tests it
  path: string;
  draft: boolean;
  children?: VisNode[];
};

export type VisibleOpts = {
  drafts?: boolean; // drop draft_ entries
  notes?: boolean; // drop notes.md files
  empty?: boolean; // drop empty directories
  // escape hatch for the sidebar's drag preview: an empty folder the user is
  // aiming a drop INTO must stay on screen
  keepEmpty?: (n: VisNode) => boolean;
};

export function visibleNodes<N extends VisNode>(nodes: N[], o: VisibleOpts): N[] {
  const out: N[] = [];
  for (const n of nodes) {
    if (o.drafts && n.draft) continue;
    if (o.notes && n.children === undefined && NOTES.test(n.name)) continue;
    if (n.children !== undefined) {
      const leaf = n.children.length === 0;
      if (o.empty && leaf && !o.keepEmpty?.(n)) continue;
      const kids = visibleNodes(n.children, o);
      if (!kids.length && !leaf) continue;
      out.push({ ...n, children: kids });
    } else {
      out.push(n);
    }
  }
  return out;
}
