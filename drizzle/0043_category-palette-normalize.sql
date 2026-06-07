-- Category colours are now a fixed palette (the shared CATEGORY_PALETTE), so
-- both the plan sidebar and the universe settings editor pick from the same
-- set. Categories coloured with the old free hex picker hold values outside
-- that set; map each to the nearest palette token by RGB distance so every
-- stored colour is a token the pickers and the validator agree on. This is a
-- deliberate one-time normalisation of the colour column on affected rows.
with palette(token, r, g, b) as (
	values
		('var(--cat-red)', 207, 70, 59),
		('var(--cat-amber)', 176, 123, 52),
		('var(--cat-lime)', 127, 158, 44),
		('var(--cat-green)', 63, 154, 79),
		('var(--cat-teal)', 31, 150, 133),
		('var(--cat-cyan)', 31, 135, 168),
		('var(--cat-blue)', 59, 91, 219),
		('var(--cat-violet)', 125, 95, 224),
		('var(--cat-fuchsia)', 168, 67, 176),
		('var(--cat-rose)', 194, 85, 122)
),
targets as (
	select
		id,
		('x' || lpad(substr(color, 2, 2), 8, '0'))::bit(32)::int as r,
		('x' || lpad(substr(color, 4, 2), 8, '0'))::bit(32)::int as g,
		('x' || lpad(substr(color, 6, 2), 8, '0'))::bit(32)::int as b
	from entity_categories
	where color is not null and color ~* '^#[0-9a-f]{6}$'
),
nearest as (
	select distinct on (t.id) t.id, p.token
	from targets t
	cross join palette p
	order by t.id, ((t.r - p.r) * (t.r - p.r) + (t.g - p.g) * (t.g - p.g) + (t.b - p.b) * (t.b - p.b))
)
update entity_categories ec
set color = nearest.token
from nearest
where ec.id = nearest.id;
--> statement-breakpoint
-- Any remaining non-null colour that is neither a palette token nor 6-digit
-- hex (legacy free-text from before colour validation) falls back to a token.
update entity_categories
set color = 'var(--cat-blue)'
where color is not null
	and color not in (
		'var(--cat-red)', 'var(--cat-amber)', 'var(--cat-lime)', 'var(--cat-green)',
		'var(--cat-teal)', 'var(--cat-cyan)', 'var(--cat-blue)', 'var(--cat-violet)',
		'var(--cat-fuchsia)', 'var(--cat-rose)'
	);
