/**
 * Describes the agencies, how it should get the data
 * and where it should load the data from.
 */
const gtfsImportConfiguration = {
    agencies: [
        {
            agency_key: 'carris',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=1&u=web',
        },
        {
            agency_key: 'carristur',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=71&u=web',
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
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=21&u=web',
        },
        {
            agency_key: 'tcb',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=41&u=web',
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
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=11&u=web',
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
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=3&u=web',
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
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=13&u=web',
        },
        {
            agency_key: 'metro-lisboa',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=2&u=web',
        },
        {
            agency_key: 'mts',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=12&u=web',
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
                'https://www.transporlis.pt/desktopmodules/trp_opendata/ajax/downloadFile.ashx?op=4&u=web',
        },
        {
            agency_key: 'stcp',
            exclude: [
                'fare_attributes',
                'fare_rules',
                'transfers',
                'feed_info',
            ],
            url:
                'https://opendata.porto.digital/dataset/5275c986-592c-43f5-8f87-aabbd4e4f3a4/resource/1f845744-1962-4108-a20c-ac3357d0957b/download/gtfs-stcp.zip',
        }
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
