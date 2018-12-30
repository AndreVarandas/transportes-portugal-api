import express from 'express'
import MainController from '../controllers/Main.controller'

const apiRouter = express.Router()

/**
 * Declare all the possible paths that will "trigger"
 * the MainController
 */
apiRouter.post(
    [
        '/agencies',
        '/routes',
        '/stops',
        '/stops-geojson',
        '/stop-times',
        '/trips',
        '/directions-by-route',
        '/shapes',
        '/calendars',
        '/frequencies',
    ],
    MainController.getResource,
)

export default apiRouter
