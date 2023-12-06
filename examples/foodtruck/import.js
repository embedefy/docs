import { parse } from 'csv-parse'
import pg from 'pg'
import { request as embedefyRequest } from './embedefy.js'

// Init vars
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:54321/postgres' })
const embedefyAccessToken = process.env.EMBEDEFY_ACCESS_TOKEN
const trucksData = await fetchData('https://data.sfgov.org/api/views/rqzj-sfat/rows.csv')
const schedulesData = await fetchData('https://data.sfgov.org/api/views/jjew-r69b/rows.csv')

// Import the data into the database
await initDBSchema()
await importLocations(trucksData)
await importTrucks(trucksData)
await importFoods(trucksData)
await importSchedules(schedulesData)
await generateEmbeddings(embedefyAccessToken)
await pool.end()

// fetchData fetches the data from the given URL.
async function fetchData(url) {
  try {
    const response = await fetch(url)
    return await response.text()
  } catch (err) {
    throw new Error(`failed to fetch data: ${err}`)
  }
}

// trucksMap returns a map of truck names to truck IDs.
async function trucksMap() {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM trucks ORDER BY name`)
    return rows.reduce((acc, row) => {
      acc[row.name] = row.id
      return acc
    }, {})
  } catch (err) {
    throw new Error(`failed to retrieve trucks: ${err}`)
  }
}

// initDBSchema initializes the database schema.
async function initDBSchema() {
  console.log('initializing database schema...')

  const query = `
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      address VARCHAR(255),
      description VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS locations_address_idx ON locations (address);

    CREATE TABLE IF NOT EXISTS trucks (
      id SERIAL PRIMARY KEY,
      name citext UNIQUE,
      food_items text,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS trucks_name_idx ON trucks (name);

    CREATE TABLE IF NOT EXISTS trucks_locations (
      truck_id INTEGER NOT NULL REFERENCES trucks(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      status citext,
      UNIQUE(truck_id, location_id)
    );
    CREATE INDEX IF NOT EXISTS trucks_locations_truck_id_idx ON trucks_locations (truck_id);
    CREATE INDEX IF NOT EXISTS trucks_locations_location_id_idx ON trucks_locations (location_id);
    CREATE INDEX IF NOT EXISTS trucks_locations_status_idx ON trucks_locations (status);

    CREATE TABLE IF NOT EXISTS foods (
      id SERIAL PRIMARY KEY,
      name citext UNIQUE,
      embedding vector(384) DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS foods_name_idx ON foods (name);
    CREATE INDEX IF NOT EXISTS foods_embedding_idx ON foods USING hnsw (embedding vector_cosine_ops);

    CREATE TABLE IF NOT EXISTS trucks_foods (
      truck_id INTEGER NOT NULL REFERENCES trucks(id),
      food_id INTEGER NOT NULL REFERENCES foods(id),
      UNIQUE(truck_id, food_id)
    );
    CREATE INDEX IF NOT EXISTS trucks_foods_truck_id_idx ON trucks_foods (truck_id);
    CREATE INDEX IF NOT EXISTS trucks_foods_food_id_idx ON trucks_foods (food_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      truck_id INTEGER NOT NULL REFERENCES trucks(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      day_order SMALLINT,
      day_of_week VARCHAR(10),
      start_time TIME,
      end_time TIME,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      UNIQUE(truck_id, location_id, day_order)
    );
    CREATE INDEX IF NOT EXISTS schedules_truck_id_idx ON schedules (truck_id);
    CREATE INDEX IF NOT EXISTS schedules_location_id_idx ON schedules (location_id);
    CREATE INDEX IF NOT EXISTS schedules_day_order_idx ON schedules (day_order);
    CREATE INDEX IF NOT EXISTS schedules_day_of_week_idx ON schedules (day_of_week);
    CREATE INDEX IF NOT EXISTS schedules_start_time_idx ON schedules (start_time);
    CREATE INDEX IF NOT EXISTS schedules_end_time_idx ON schedules (end_time);
  `
  try {
    await pool.query(query)
  } catch (err) {
    throw new Error(`failed to initialize database schema: ${err}`)
  }
}

// importLocations imports the locations from the given CSV data.
async function importLocations(data) {
  console.log('importing locations...')

  const parser = parse(data, { columns: true })
  try {
    for await (const record of parser) {
      await pool.query(
        `
        INSERT INTO locations (id, address, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET address = $2, description = $3, updated_at = NOW()
        `,
        [record.locationid, record.Address, record.LocationDescription]
      )
    }
  } catch (err) {
    throw new Error(`failed to import locations: ${err}`)
  }
}

// importTrucks imports the trucks from the given CSV data.
async function importTrucks(data) {
  console.log('importing trucks...')

  const parser = parse(data, { columns: true })
  try {
    for await (const record of parser) {
      const res = await pool.query(
        `
        INSERT INTO trucks (name, food_items)
        VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE SET food_items = $2, updated_at = NOW()
        RETURNING id
        `,
        [record.Applicant, record.FoodItems]
      )

      // Create trucks_locations record
      await pool.query(
        `
        INSERT INTO trucks_locations (truck_id, location_id, status)
        VALUES ($1, $2, $3)
        ON CONFLICT (truck_id, location_id) DO NOTHING
        `,
        [res.rows[0].id, record.locationid, record.Status]
      )
    }
  } catch (err) {
    throw new Error(`failed to import trucks: ${err}`)
  }
}

// importFoods imports the foods from the given CSV data.
async function importFoods(data) {
  console.log('importing foods...')

  const parser = parse(data, { columns: true })
  try {
    const trucks = await trucksMap()
    for await (const record of parser) {
      // Example FoodItems record:
      // Burgers: melts: hot dogs: burritos:sandwiches: fries: onion rings: drinks
      // Split from : and remove whitespace and empty items
      const items = record.FoodItems.split(':')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .filter((item) => item.length < 32)

      for (const item of items) {
        try {
          const res = await pool.query(
            `
            INSERT INTO foods (name)
            VALUES ($1)
            ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
            RETURNING id
            `,
            [item]
          )

          // Create trucks_foods record
          await pool.query(
            `
            INSERT INTO trucks_foods (truck_id, food_id)
            VALUES ($1, $2)
            ON CONFLICT (truck_id, food_id) DO NOTHING
            `,
            [trucks[record.Applicant], res.rows[0].id]
          )
        } catch (err) {
          throw new Error(`failed to import food ${item}: ${err}`)
        }
      }
    }
  } catch (err) {
    throw new Error(`failed to import foods: ${err}`)
  }
}

// importSchedules imports the schedules from the given CSV data.
async function importSchedules(data) {
  console.log('importing schedules...')

  const parser = parse(data, { columns: true })
  try {
    const trucks = await trucksMap()
    for await (const record of parser) {
      try {
        await pool.query(
          `
          INSERT INTO schedules (truck_id, location_id, day_order, day_of_week, start_time, end_time)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (truck_id, location_id, day_order) DO UPDATE SET day_of_week = $4, start_time = $5, end_time = $6, updated_at = NOW()
          `,
          [
            trucks[record.Applicant],
            record.locationid,
            record.DayOrder,
            record.DayOfWeekStr,
            record.start24,
            record.end24,
          ]
        )
      } catch (err) {
        throw new Error(`failed to import schedule: ${err}`)
      }
    }
  } catch (err) {
    throw new Error(`failed to import schedules: ${err}`)
  }
}

// generateEmbeddings generates embeddings for all items in the database.
async function generateEmbeddings(token) {
  console.log('generating embeddings...')

  // foods
  try {
    const { rows } = await pool.query(`SELECT id, name FROM foods WHERE embedding IS NULL`)
    for (const row of rows) {
      console.log(`generating embedding for ${row.name}`)

      const vector = JSON.stringify(await embedefyRequest(token, row.name))
      await pool.query(`UPDATE foods SET embedding = $1 WHERE name = $2`, [vector, row.name])
    }
  } catch (err) {
    throw new Error(`failed to generate embeddings: ${err}`)
  }

  console.log('done')
}
