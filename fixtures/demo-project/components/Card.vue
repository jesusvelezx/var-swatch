<template>
  <div class="card" style="border-color: var(--accent)">
    <slot />
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/tokens' as t;

.card {
  color: t.$purple;
  background: rgba(t.$green, .1);
  box-shadow: 0 1px 2px var(--primary);
}
</style>
