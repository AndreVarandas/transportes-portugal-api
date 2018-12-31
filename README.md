# Transportes Portugal API 🚂

![](https://travis-ci.com/AndreVarandas/transportes-portugal-api.svg?token=Qxpxo4Qy2WURs7b8zWyM&branch=master)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
![](https://badges.greenkeeper.io/andrevarandas/transportes-portugal-api.svg?style=flat)

All the available data about the major public transportation providers of Portugal from GTFS (General Transit Feed Specification)
to a rest API.

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites

The project will not work without the following prerequisites:

- [Node >= 9](https://nodejs.org/en/download/)

- [MongoDb](https://www.mongodb.com/download-center/community)

Optional

- [Postman](https://www.getpostman.com/) - The api only accepts post requests, postman is a good tool to test api's.

### Installing

Install with

```
npm install
```

Start the development server

```
npm run dev
```

**Important**

By default, importing data is disabled by the env variable `SKIP_IMPORT=true`. 

On your very first run, you may want to
**remove** this variable, in order to get some data.

**Try it out**

Go to [http://localhost:3000](http://localhost:3000) to check that the app is running.

Open *Postman* and send an empty POST to `http://localhost:3000/api/v1/agencies` to get all the available providers. 

## Deployment

Build a production ready package with

```
npm run build
```

And start the production package with

```
npm start
```

## Current Agencies

- **Comboios de Portugal** - agency_key: 'cp'
- **Metro de Lisboa** - agency_key: 'metro-lisboa'
- **Carris** - agency_key: 'carris'
- **Fertagus**- agency_key: 'fertagus'
- **Soflusa** - agency_key: 'soflusa'
- **Sulfertagus** - agency_key: 'sulfertagus'
- **Transtejo** - agency_key: 'transtejo'
- **Rodoviária** de Lisboa - agency_key: 'rodoviaria-de-lisboa'
- **Transportes** Sul do Tejo - agency_key: 'tst'

## Examples

Querying for an agency POST `/agencies`

```javascript
// Get one agency by agency key
fetch('http://localhost:3000/api/v1/agencies', {
	method: 'POST',
	headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
	body: JSON.stringify({ 
	    query: { agency_key: 'metro-lisboa' } 
	})
})
    .then(res => res.json())
    .then(resp => console.log(resp))
    
// Will log details about the agency.
```

## Contributing

Please read [CONTRIBUTING.md](https://github.com/AndreVarandas/transportes-portugal-api/blob/master/.github/CODE_OF_CONDUCT.md) for details on our code of conduct, and the process for submitting pull requests to us.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/andrevarandas/transportes-portugal-api/tags). 

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
