import pg from 'pg'
import express from 'express'
import bodyParser from 'body-parser'
import OpenAI from 'openai'
import { request as embedefyRequest } from './embedefy.js'

// Check the environment variables
if (!process.env.EMBEDEFY_ACCESS_TOKEN) {
  throw new Error('missing EMBEDEFY_ACCESS_TOKEN')
} else if (!process.env.OPENAI_API_KEY) {
  throw new Error('missing OPENAI_API_KEY')
}

// Init vars
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:54321/postgres' })
const embedefyAccessToken = process.env.EMBEDEFY_ACCESS_TOKEN
const openAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const openAIModel = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'
const appHost = process.env.APP_HOST || 'localhost'
const appPort = process.env.APP_PORT || 3003

// Init the API server
const app = express()
app.use(bodyParser.json({ type: 'application/json' }))
app.use(bodyParser.urlencoded({ extended: false }))

// Add handler for the user query
app.post('/', async (req, res) => {
  // Check the request
  const userQuery = req.body.query
  if (!userQuery) {
    res.status(400).json({ error: 'missing query' })
    return
  }

  console.log(`generating embedding for "${userQuery}"`)

  // Generate embeddings from the user query
  const foods = []
  try {
    const userEmbedding = JSON.stringify(await embedefyRequest(embedefyAccessToken, userQuery))

    // Query the database for the most similar food items
    const { rows: foodRows } = await pool.query(
      `
      SELECT id, name, 1 - (embedding <=> $1) AS cosine_similarity
      FROM foods
      ORDER BY cosine_similarity DESC
      LIMIT 5
      `,
      [userEmbedding]
    )
    for (const row of foodRows) {
      foods.push({
        id: row.id,
        name: row.name,
        cosine_similarity: row.cosine_similarity,
      })
    }
    // console.log('foods', JSON.stringify(foods, null, 2))
  } catch (err) {
    res.json({ error: `failed to generate embeddings: ${err}` })
    return
  }

  // Query the database for the trucks that serve the requested foods items, approved locations, and schedules
  const truckList = []
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        t.id AS truck_id,
        t.name AS truck_name,
        t.food_items AS food_items,
        l.id AS location_id,
        l.address AS address,
        s.day_of_week,
        to_char(s.start_time, 'HH12:MI AM') AS start_time,
        to_char(s.end_time, 'HH12:MI AM') AS end_time,
        tl.status
      FROM 
        trucks t
      INNER JOIN 
        trucks_foods tf ON t.id = tf.truck_id
      INNER JOIN 
        trucks_locations tl ON t.id = tl.truck_id AND tl.status = 'APPROVED'
      INNER JOIN 
        locations l ON tl.location_id = l.id
      INNER JOIN 
        schedules s ON t.id = s.truck_id AND tl.location_id = s.location_id
      WHERE 
        tf.food_id IN (${foods.map((_, i) => `$${i + 1}`).join(', ')})
      ORDER BY 
        truck_id, location_id, day_of_week, start_time
      `,
      foods.map((food) => food.id)
    )

    // Iterate over the rows and build the trucks object
    for (const row of rows) {
      // Check if the truck already exists
      const truck = truckList.find((truck) => truck.id === row.truck_id)
      if (!truck) {
        // Add the truck
        truckList.push({
          id: row.truck_id,
          name: row.truck_name,
          foodItems: row.food_items,
          locations: [],
        })
      }

      // Check if the location already exists
      const location = truckList[truckList.length - 1].locations.find((location) => location.id === row.location_id)
      if (!location) {
        // Add the location
        truckList[truckList.length - 1].locations.push({
          id: row.location_id,
          address: row.address,
          status: row.status,
          schedules: [],
        })
      }

      // Check if the schedule already exists
      const schedule = truckList[truckList.length - 1].locations[
        truckList[truckList.length - 1].locations.length - 1
      ].schedules.find((schedule) => schedule.day_of_week === row.day_of_week)
      if (!schedule) {
        // Add the schedule
        truckList[truckList.length - 1].locations[truckList[truckList.length - 1].locations.length - 1].schedules.push({
          day_of_week: row.day_of_week,
          start_time: row.start_time,
          end_time: row.end_time,
        })
      }
    }
    // console.log('truckList', JSON.stringify(truckList, null, 2))
  } catch (err) {
    res.json({ error: `failed to query database: ${err}` })
    return
  }

  if (truckList.length === 0) {
    console.log('no database results found')

    res.json({ response: 'No food trucks found.' })
    return
  }

  // Prepare the OpenAI user content
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  let content = `Current date: ${now}\n`
  for (const truck of truckList) {
    content = `${content}-\nFood Truck: ${truck.name}`
    content = `${content}\nMenu: ${truck.foodItems}`
    for (const location of truck.locations) {
      content = `${content}\nLocation: ${location.address}`
      // content = `${content} - Permit status: ${location.status}`
      for (const schedule of location.schedules) {
        content = `${content} - ${schedule.day_of_week} ${schedule.start_time} - ${schedule.end_time}`
      }
    }
    content = `${content}\n`
  }
  content = `${content}-\n\nUser query: ${userQuery}`
  // console.log(content)

  console.log('retrieving OpenAI response...')

  // Make a request to OpenAI's chat endpoint
  let chatResponse
  try {
    const chatCompletion = await openAI.chat.completions.create({
      model: openAIModel,
      messages: [
        {
          role: 'system',
          content:
            `You will be provided with a list of food trucks, along with their food items, locations, and schedules.` +
            ` Reply the user queries by with food trucks that are currently open or about to open, and serve food items matching the user's query.` +
            ` You must provide location and schedule information. Answer like humans do, not like a machine. Do not use structured responses.`,
        },
        {
          role: 'user',
          content: 'Where can I eat chicken quesadillas?',
        },
        {
          role: 'assistant',
          content: 'Here are the locations and schedules',
        },
        {
          role: 'user',
          content: content,
        },
      ],
    })
    // console.log('chatCompletion', JSON.stringify(chatCompletion, null, 2))
    if (chatCompletion?.choices?.length > 0) {
      chatResponse = chatCompletion.choices[0].message?.content?.trim()
    } else {
      res.json({ error: 'failed to get OpenAI response: no content found' })
      return
    }
  } catch (err) {
    res.json({ error: `failed to get OpenAI response: ${err}` })
    return
  }
  console.log('request completed')

  res.json({ response: chatResponse })
})

// Start the API server
app.listen(appPort, appHost, () => {
  console.log(`server listening on port ${appHost}:${appPort}`)
})
