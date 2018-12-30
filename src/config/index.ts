/**
 * Describes the agencies, how it should get the data
 * and where it should load the data from.
 */
const gtfsImportConfiguration = {
    agencies: [
        {
            agency_key: 'metro-lisboa',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/2/gtfs_2.zip',
        },
        {
            agency_key: 'carris',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/1/gtfs_1.zip',
        },
        {
            agency_key: 'fertagus',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/13/gtfs_13.zip',
        },
        {
            agency_key: 'soflusa',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/14/gtfs_14.zip',
        },
        {
            agency_key: 'cp',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/3/gtfs_3.zip',
        },
        {
            agency_key: 'sulfertagus',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/21/gtfs_21.zip',
        },
        {
            agency_key: 'transtejo',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/4/gtfs_4.zip',
        },
        {
            agency_key: 'rodoviaria-de-lisboa',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/61/gtfs_61.zip',
        },
        {
            agency_key: 'tst',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/Portals/0/OpenData/gtfs/zip/11/gtfs_11.zip',
        },
    ],
}

/**
 * The mongodb database url to use.
 * During local development please use your local mongodb database.
 */
let databaseURI: string | undefined = 'mongodb://localhost/gtfs'
if (
    process.env.NODE_ENV !== undefined &&
    process.env.NODE_ENV === 'production'
) {
    databaseURI = process.env.MONGOLAB_URI
}

export { databaseURI, gtfsImportConfiguration }
