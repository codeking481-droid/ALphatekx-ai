import { searchTavily } from './tavily-search.mjs'

process.once('message', async (input) => {
  try {
    const result = await searchTavily({
      query: input?.query,
      maxResults: input?.maxResults,
      apiKey: process.env.TAVILY_API_KEY,
    })
    process.send({ type: 'result', result })
  } catch (error) {
    process.send({ type: 'error', message: safeMessage(error) })
  } finally {
    process.disconnect()
  }
})

function safeMessage(error) {
  return typeof error?.message === 'string' ? error.message.slice(0, 300) : 'Web search failed.'
}
