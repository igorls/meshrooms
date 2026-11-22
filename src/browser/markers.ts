/**
 * Removal markers: the operation that says a task was removed or a reaction taken back. A device keeps one so that a
 * device which missed the removal can't bring the task or reaction back, and markers used to be kept for good. One
 * member could then fill a room's task or reaction log with create-and-remove pairs, after which nobody could add
 * either. Compaction now keeps each member's newest markers only.
 *
 * The cost, accepted: once a member has made more removals than their share, a device that still holds one of the
 * forgotten items (it was away when the item was removed, and has held it since) can bring it back when it reconnects,
 * until someone removes it again. Only that member's oldest removals are exposed.
 */

/** The ids of each member's newest `max` items: newest by `at`, then by id, so every device picks the same ones. */
export function newestPerMember(items: readonly { id: string; memberId: string; at: number }[], max: number): Set<string> {
  const byMember = new Map<string, { id: string; at: number }[]>();
  for (const item of items) {
    const list = byMember.get(item.memberId);
    if (list) list.push(item); else byMember.set(item.memberId, [item]);
  }
  const kept = new Set<string>();
  for (const list of byMember.values()) {
    list.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const item of list.slice(0, max)) kept.add(item.id);
  }
  return kept;
}
