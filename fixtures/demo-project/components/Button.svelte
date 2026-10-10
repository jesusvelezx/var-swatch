<button class="btn"><slot /></button>

<style lang="scss">
  @use '../styles/brand';

  .btn {
    background: brand.$brand-purple;
    color: var(--surface);
  }
</style>
