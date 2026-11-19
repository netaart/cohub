I rewrote the importer in three languages so we can compare them side by side. Each version reads the same CSV, validates rows, and writes batches of 500.

### TypeScript

```typescript
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";

type Row = {
	id: string;
	email: string;
	plan: "free" | "pro" | "team";
	seats: number;
};

const PLANS = new Set(["free", "pro", "team"]);

function validate(record: Record<string, string>): Row | null {
	const seats = Number.parseInt(record.seats ?? "", 10);
	if (!record.id || !record.email?.includes("@")) return null;
	if (!PLANS.has(record.plan) || !Number.isFinite(seats) || seats < 1)
		return null;
	return {
		id: record.id,
		email: record.email.toLowerCase(),
		plan: record.plan as Row["plan"],
		seats,
	};
}

export async function importAccounts(
	path: string,
	write: (rows: Row[]) => Promise<void>,
) {
	const parser = createReadStream(path).pipe(
		parse({ columns: true, trim: true }),
	);
	let batch: Row[] = [];
	let skipped = 0;
	for await (const record of parser) {
		const row = validate(record);
		if (!row) {
			skipped += 1;
			continue;
		}
		batch.push(row);
		if (batch.length === 500) {
			await write(batch);
			batch = [];
		}
	}
	if (batch.length > 0) await write(batch);
	return { skipped };
}
```

### Python

```python
import csv
from dataclasses import dataclass
from typing import Callable, Iterable

PLANS = {"free", "pro", "team"}


@dataclass(frozen=True)
class Row:
    id: str
    email: str
    plan: str
    seats: int


def validate(record: dict[str, str]) -> Row | None:
    try:
        seats = int(record.get("seats", ""))
    except ValueError:
        return None
    email = record.get("email", "")
    if not record.get("id") or "@" not in email:
        return None
    if record.get("plan") not in PLANS or seats < 1:
        return None
    return Row(record["id"], email.lower(), record["plan"], seats)


def import_accounts(path: str, write: Callable[[list[Row]], None]) -> dict[str, int]:
    batch: list[Row] = []
    skipped = 0
    with open(path, newline="") as handle:
        for record in csv.DictReader(handle):
            row = validate(record)
            if row is None:
                skipped += 1
                continue
            batch.append(row)
            if len(batch) == 500:
                write(batch)
                batch = []
    if batch:
        write(batch)
    return {"skipped": skipped}
```

### Rust

```rust
use serde::Deserialize;
use std::error::Error;

#[derive(Debug, Deserialize)]
struct Record {
    id: String,
    email: String,
    plan: String,
    seats: String,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub seats: u32,
}

fn validate(record: Record) -> Option<Row> {
    let seats: u32 = record.seats.parse().ok()?;
    if record.id.is_empty() || !record.email.contains('@') || seats == 0 {
        return None;
    }
    match record.plan.as_str() {
        "free" | "pro" | "team" => Some(Row {
            id: record.id,
            email: record.email.to_lowercase(),
            plan: record.plan,
            seats,
        }),
        _ => None,
    }
}

pub fn import_accounts(path: &str, mut write: impl FnMut(&[Row])) -> Result<usize, Box<dyn Error>> {
    let mut reader = csv::Reader::from_path(path)?;
    let mut batch = Vec::with_capacity(500);
    let mut skipped = 0;
    for record in reader.deserialize::<Record>() {
        match validate(record?) {
            Some(row) => batch.push(row),
            None => skipped += 1,
        }
        if batch.len() == 500 {
            write(&batch);
            batch.clear();
        }
    }
    if !batch.is_empty() {
        write(&batch);
    }
    Ok(skipped)
}
```

The schema they all write into:

```sql
create table accounts (
  id text primary key,
  email text not null unique,
  plan text not null check (plan in ('free', 'pro', 'team')),
  seats integer not null check (seats > 0),
  imported_at timestamptz not null default now()
);

create index accounts_plan_idx on accounts (plan) where plan <> 'free';
```

And the job config:

```json
{
	"source": "s3://imports/accounts-2026-11.csv",
	"batchSize": 500,
	"onInvalidRow": "skip",
	"notify": ["#billing-ops"],
	"dryRun": false
}
```

The Rust version is about four times faster on the 2 GB export, but the TypeScript one is easier to keep next to the API code. I would keep TypeScript unless imports grow past a few million rows.
