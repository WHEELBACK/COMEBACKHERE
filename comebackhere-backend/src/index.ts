import { createApp } from "./app.js"

const PORT = process.env.PORT ?? "3000"
const app = createApp()

app.listen(Number(PORT), () => {
  console.log(`comebackhere-backend listening on port ${PORT}`)
})
