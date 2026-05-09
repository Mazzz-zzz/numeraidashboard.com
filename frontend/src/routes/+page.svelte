<script lang="ts">
</script>

<div class="hero">
	<h1>Numerai Dashboard</h1>
	<p class="lede">Train and deploy Numerai models on Prime Intellect.</p>

	<div class="cards">
		<a href="/ml" class="card">
			<h3>ML</h3>
			<p>Experiments, models, rounds, and live training runs.</p>
		</a>
		<a href="/chart" class="card">
			<h3>Chart</h3>
			<p>Price + option-chain context.</p>
		</a>
	</div>
</div>

<style>
	.hero { padding: 2rem 0; }
	h1 { font-size: 2rem; font-weight: 700; margin: 0 0 0.5rem; }
	.lede { color: var(--text-secondary); margin: 0 0 2rem; font-size: 1.05rem; }

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 1rem;
	}

	.card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.25rem;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s, box-shadow 0.15s;
	}

	.card:hover {
		border-color: var(--blue);
		box-shadow: var(--shadow-md);
	}

	.card h3 { margin: 0 0 0.4rem; color: var(--blue); font-size: 1rem; }
	.card p { margin: 0; color: var(--text-secondary); font-size: 0.875rem; }
</style>
