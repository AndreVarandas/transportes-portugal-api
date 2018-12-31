import app from './app'

const { log } = console
const PORT = process.env.PORT || 3000

/**
 * Starts the application listening on port 3000
 */
app.listen(PORT, () => {
    log('Express server listening on port ' + PORT)
})
