/**
 * VS Code RangeMap — efficient index↔pixel position mapping for virtual lists.
 * Groups consecutive items of identical height into ranges so position lookups
 * are O(n) where n = number of distinct-height groups (typically single digits).
 *
 * Mirrors: src/vs/base/browser/ui/list/rangeMap.ts
 */

function groupAdjacentBy(items, shouldGroup) {
  const groups = [];
  let currentGroup = null;
  for (const item of items) {
    if (!currentGroup || !shouldGroup(currentGroup[currentGroup.length - 1], item)) {
      currentGroup = [item];
      groups.push(currentGroup);
    } else {
      currentGroup.push(item);
    }
  }
  return groups;
}

export class RangeMap {
  constructor(topPadding = 0) {
    this._groups = [];
    this._size = 0;
    this._count = 0;
    this._topPadding = topPadding;
  }

  splice(index, deleteCount, items = []) {
    // Convert current groups to item array (only affected range)
    const before = this._groups;
    // Simple rebuild — for small group counts this is negligible
    const allItems = this._toItems();
    allItems.splice(index, deleteCount, ...items);
    this._fromItems(allItems);
  }

  _toItems() {
    const items = [];
    for (const group of this._groups) {
      for (let i = 0; i < group.count; i++) items.push(group.size);
    }
    return items;
  }

  _fromItems(items) {
    this._groups = [];
    this._size = this._topPadding;
    this._count = items.length;

    for (const item of items) {
      const last = this._groups[this._groups.length - 1];
      if (last && last.size === item) {
        last.count++;
      } else {
        this._groups.push({ size: item, count: 1 });
      }
      this._size += item;
    }
  }

  get count() { return this._count; }
  get size()  { return this._size; }

  // O(n) where n = number of groups
  indexAt(position) {
    if (position < this._topPadding) return -1;
    let pos = this._topPadding;
    let idx = 0;
    for (const group of this._groups) {
      const groupSize = group.size * group.count;
      if (position < pos + groupSize) {
        return idx + Math.floor((position - pos) / group.size);
      }
      pos += groupSize;
      idx += group.count;
    }
    return this._count;
  }

  // O(n) where n = number of groups
  positionAt(index) {
    if (index < 0) return -1;
    let pos = this._topPadding;
    let idx = 0;
    for (const group of this._groups) {
      if (index < idx + group.count) {
        return pos + (index - idx) * group.size;
      }
      pos += group.size * group.count;
      idx += group.count;
    }
    return -1;
  }

  // Returns the items in the visible range [renderTop, renderTop + renderHeight)
  getRenderRange(renderTop, renderHeight) {
    const start = Math.max(0, this.indexAt(renderTop));
    const end   = Math.min(this._count - 1, this.indexAt(renderTop + renderHeight - 1));
    return { start, end };
  }
}
