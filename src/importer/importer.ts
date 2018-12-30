import gtfs from 'gtfs'

import { gtfsImportConfiguration } from '../config'

const { log, error } = console
const ONE_DAY_MS = 86400000

/**
 * This class is responsible for downloading, unzipping and importing
 * data, according to the import configurations to the mongodb database.
 *
 * Note:
 * A previous mongodb connection is required.
 */
export default class GtfsImporter {
    constructor() {
        this.importGtfsFilesToDatabase()
        this.setupDailyImports()
    }

    /**
     * Imports the gtfs files as specified on the configuration file
     * (src/config/index.ts)
     */
    private importGtfsFilesToDatabase() {
        // @ts-ignore
        gtfs.import(gtfsImportConfiguration)
            .then(() => {
                log('Import Successful')
            })
            .catch((err: any) => {
                error(err)
            })
    }

    /**
     * Schedule new imports to happen each day.
     * Keeps the data fresh!
     */
    private setupDailyImports() {
        setInterval(this.importGtfsFilesToDatabase, ONE_DAY_MS)
    }
}
