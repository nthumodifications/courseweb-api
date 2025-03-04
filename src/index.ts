import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import acaCalendar from './aca-calendar'
import weather from './weather'
import course from './course'
import venue from './venue'
import shortlink from './shortlink'

export const app = new Hono()
  .use(cors({
    origin: process.env.NODE_ENV === 'production' ? 'https://nthumods.com' : '*',
  }))
  .use(logger())
  .get('/', (c) => {
    return c.text('Hello Hono!')
  })
  .route('/acacalendar', acaCalendar)
  .route('/weather', weather)
  .route('/course', course)
  .route('/venue', venue)
  .route('/shortlink', shortlink)
  
const port = parseInt(process.env.PORT!) || 3000

export default {
  port: port,
  fetch: app.fetch
}