// request makes a request to the Embedefy API.
export async function request(token, text) {
  const res = await fetch('https://api.embedefy.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'e5-small-v2',
      inputs: [text],
    }),
  })
  const data = await res.json()
  if (data.error) {
    throw new Error(`failed to generate embedding ${data.error}: ${data.message}`)
  } else if (data.inputs.length === 0) {
    throw new Error(`failed to generate embedding: no inputs`)
  }

  return Array.from(data.inputs[0].data)
}
