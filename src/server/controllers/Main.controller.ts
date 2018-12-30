import express from 'express'
import gtfs from 'gtfs'

const { error } = console

/**
 * MainController class
 * This controller manages all the api calls.
 */
export default class MainController {
    /**
     * This is the only function,
     * used to dynamically fetches resources, based on the req.path (url path)
     *
     * @param req Express.Request
     * @param res Express.Response
     */
    public static async getResource(
        req: express.Request,
        res: express.Response,
    ) {
        const query = req.body.query
        const projection = req.body.projection
        const options = req.body.options
        /**
         * Function that will run and fetch gtfs data.
         */
        let executor

        if (query && query.within && query.within.radius) {
            /**
             * The api currently only works with miles.
             * Do a quick conversion to miles by multiplying the km * 0.6
             */
            query.within.radius = Math.round(query.within.radius * 0.621371192)
        }

        /**
         * Decide the executor (function) to call, depending on our url path
         */
        switch (req.path) {
            case '/agencies':
                executor = gtfs.getAgencies
                break
            case '/routes':
                executor = gtfs.getRoutes
                break
            case '/stops':
                executor = gtfs.getStops
                break
            case '/stops-geojson':
                executor = gtfs.getStopsAsGeoJSON
                break
            case '/stop-times':
                executor = gtfs.getStoptimes
                break
            case '/trips':
                executor = gtfs.getTrips
                break
            case '/directions-by-route':
                executor = gtfs.getDirectionsByRoute
                break
            case '/shapes':
                executor = gtfs.getShapes
                break
            case '/shapes-geojson':
                executor = gtfs.getShapesAsGeoJSON
                break
            case '/calendars':
                executor = gtfs.getCalendars
                break
            case '/frequencies':
                executor = gtfs.getFrequencies
                break
            default:
                executor = () => {
                    error('Unable to find a matching executor.')
                }
                break
        }

        try {
            /**
             * Execute the requested function, passing in the arguments
             * from the POST body. undefined args will be ignored.
             */
            const data = await executor(query, projection, options)
            return res.status(200).json({
                results: data,
            })
        } catch (err) {
            /**
             * Something happened, we don't want to go into details,
             * we simply send a 404 and a short message.
             */
            return res
                .status(404)
                .json({ error: 'The resource was not found.' })
        }
    }
}
