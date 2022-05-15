import bodyParser from 'body-parser'
import express from 'express'
import mongoose from 'mongoose'

import { databaseURI } from './config'
import GtfsImporter from './importer/importer'
import apiRouter from './server/routes'

const { error } = console

/**
 * Custom error status
 */
interface IErrorWithStatus extends Error {
    status?: number
}

/**
 * Main application class
 */
class App {
    /**
     * Handles not found resources
     *
     * @param req  ExpressRequest
     * @param res  ExpressResponse
     * @param next ExpressNext
     */
    public static notFoundHandler(
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) {
        res.status(404).json({ message: 'Resource not found.' })
        next()
    }

    /**
     * Handle server errors
     *
     * @param err  IErrorWithStatus
     * @param req  ExpressRequest
     * @param res  ExpressResponse
     * @param next ExpressNext
     */
    public static errorHandler(
        err: IErrorWithStatus,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) {
        const message = req.app.get('env') === 'development' ? err.message : ''
        const status = err.status || 500
        res.status(status).json({ error: message })
        next()
    }

    /**
     * Create a new instance of the gtfsImporter - it will live through
     * all the application lifecycle.
     */
    private static setupImporter() {
        if (process.env.SKIP_IMPORT === 'false') {
            return new GtfsImporter()
        }
    }

    public app: express.Application

    constructor() {
        this.app = express()
        this.config()
    }

    /**
     * Configures express application
     */
    private config(): void {
        // Setup the database
        this.setupMongoose()
        // Setup the importer
        App.setupImporter()
        // support application/json type post data
        this.app.use(bodyParser.json())
        // support application/x-www-form-urlencoded post data
        this.app.use(bodyParser.urlencoded({ extended: false }))
        // Use the api prefix for the api routes defined on the server object
        this.app.use('/api/v1', apiRouter)
        // Handle 404's
        this.app.use(App.notFoundHandler)
        // Handle errors
        this.app.use(App.errorHandler)
    }

    /**
     * Creates a connection to the mongodb database
     */
    private setupMongoose() {
        mongoose.connect(
            // @ts-ignore
            databaseURI,
            { useNewUrlParser: true },
        )

        mongoose.connection.on('error', () =>
            error('MongoDB connection error', error),
        )
    }
}

export default new App().app
