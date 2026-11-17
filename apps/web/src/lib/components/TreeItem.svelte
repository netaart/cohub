<script lang="ts">
import TreeItem from "#lib/components/TreeItem.svelte";
import type { RepositoryTreeNode } from "#lib/types.ts";

const {
	node,
	depth,
	selectedPath,
	onToggle,
	onSelect,
}: {
	node: RepositoryTreeNode;
	depth: number;
	selectedPath: string;
	onToggle: (node: RepositoryTreeNode) => void;
	onSelect: (node: RepositoryTreeNode) => void;
} = $props();

const handleClick = () => {
	if (node.type === "dir") {
		onToggle(node);
		return;
	}

	onSelect(node);
};

const icon = $derived.by(() => {
	if (node.type === "dir") {
		return node.isOpen ? "▾" : "▸";
	}
	return "·";
});

const isActive = $derived(selectedPath === node.path);
</script>

<button
  class:active={isActive}
  class="tree-item"
  style={`padding-left: ${depth * 14 + 12}px`}
  onclick={handleClick}
  type="button"
>
  <span class="icon">{icon}</span>
  <span class="name">{node.name}</span>
  {#if node.isLoading}
    <span class="loading">...</span>
  {/if}
</button>

{#if node.type === "dir" && node.isOpen && depth < 50}
  {#each node.children as child (child.path)}
    <TreeItem
      node={child}
      depth={depth + 1}
      {selectedPath}
      {onToggle}
      {onSelect}
    />
  {/each}
{/if}

<style>
  .tree-item {
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    display: flex;
    gap: 6px;
    align-items: center;
    padding-block: 6px;
    cursor: pointer;
  }

  .tree-item:hover {
    background: var(--bg-hover);
  }

  .tree-item.active {
    background: var(--brand-bg);
    color: var(--brand-contrast-fg);
  }

  .icon {
    width: 10px;
    color: var(--text-tertiary);
  }

  .name {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: 12px;
  }
</style>
