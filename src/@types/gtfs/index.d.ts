// Type definitions for gtfs 1.6
// Project: https://github.com/blinktaginc/node-gtfs#readme
// Definitions by: My Self <https://github.com/me>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

declare module 'gtfs' {
    export function getAgencies(query: any, projection: any, options: any): any

    export function getCalendarDates(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getCalendars(query: any, projection: any, options: any): any

    export function getDirectionsByRoute(query: any): any

    export function getFareAttributes(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getFareRules(query: any, projection: any, options: any): any

    export function getFeedInfo(query: any, projection: any, options: any): any

    export function getFrequencies(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getRoutes(query: any, projection: any, options: any): any

    export function getShapes(query: any, projection: any, options: any): any

    export function getShapesAsGeoJSON(query: any): any

    export function getStopAttributes(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getStops(query: any, projection: any, options: any): any

    export function getStopsAsGeoJSON(query: any): any

    export function getStoptimes(query: any, projection: any, options: any): any

    export function getTimetablePages(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getTimetableStopOrders(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getTimetables(
        query: any,
        projection: any,
        options: any,
    ): any

    export function getTransfers(query: any, projection: any, options: any): any

    export function getTrips(query: any, projection: any, options: any): any
}
