# ioBroker Daikin Cloud Adapter

ioBroker Daikin Cloud is a Node.js adapter that connects to the Daikin Cloud API to control Daikin climate devices (air conditioners, heat pumps) that use newer WLAN adapters (BRP069C4x) and are only accessible via the Daikin Onecta App.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

- Bootstrap, build, and test the repository:
  - `npm install` -- takes 30 seconds. Set timeout to 60+ seconds
  - Fix test setup if needed: In `test/mocha.setup.js`, change line 9 to `const chaiAsPromised = require('chai-as-promised').default;`
  - `npm run lint` -- takes <1 second for ESLint validation
  - `npm run check` -- takes 4 seconds for TypeScript type checking. EXPECTED: Will show TypeScript errors in main.js, this is normal and does not prevent builds
  - `npm test` -- takes <1 second. Runs JS tests and package validation. NEVER CANCEL.
  - `npm run test:integration` -- takes 30-40 seconds. NEVER CANCEL. Set timeout to 60+ minutes.

## Testing and Validation

- ALWAYS run `npm test` before committing changes - this validates package structure and basic functionality
- ALWAYS run `npm run test:integration` when making core adapter changes - this starts a full ioBroker test environment
- ALWAYS run `npm run lint` before committing - the CI will fail otherwise
- TypeScript check (`npm run check`) will show errors in main.js - this is expected behavior, not a build failure
- Integration tests create a temporary test environment in `/tmp/test-iobroker.daikin-cloud/`

## Development Environment

- Development server: `npm run dev-server` -- starts ioBroker dev environment for testing adapter locally
- The adapter is primarily JavaScript with TypeScript type checking for development safety
- Configuration UI is JSON-based (admin/jsonConfig.json) with multi-language support

## Key Project Structure

Repository root contains:
```
main.js                 # Main adapter entry point - core adapter logic
io-package.json         # ioBroker adapter metadata and configuration
package.json            # Node.js dependencies and scripts
admin/                  # Admin UI configuration files
  jsonConfig.json       # Admin configuration interface
  i18n/                 # Internationalization files
lib/                    # Library modules
  mapper.js             # Data mapping between Daikin API and ioBroker states
  tools.js              # Utility functions
test/                   # Test files
  integration.js        # ioBroker integration tests
  package.js            # Package validation tests
  mocha.setup.js        # Test environment setup
.eslintrc.json          # ESLint configuration
tsconfig.json           # TypeScript configuration for type checking
.github/workflows/      # CI/CD GitHub Actions
```

## Critical Timing Information

- **NEVER CANCEL BUILD OR TEST COMMANDS**
- npm install: ~30 seconds - Set timeout to 60+ seconds
- npm test: <1 second
- npm run test:integration: ~30-40 seconds - NEVER CANCEL, set timeout to 60+ minutes
- npm run lint: <1 second  
- npm run check: ~4 seconds

## Known Issues and Fixes

- **Test Setup Issue**: Fresh clones may have a test setup issue in `test/mocha.setup.js`. If `npm test` fails with "TypeError: fn is not a function", change line 9 from `require('chai-as-promised')` to `require('chai-as-promised').default`

## Rate Limiting and API Constraints

This adapter connects to Daikin Cloud API which has strict rate limits:
- **200 requests per day maximum**
- Default polling interval is 15 minutes (900 seconds)
- Each control action uses 2 requests (command + status update)
- Monitor rate limit states in `info.rateLimitDay` and `info.rateRemainingDay`

## Common Development Tasks

### Before Making Changes
1. `npm install` (if dependencies changed)
2. `npm run lint` (check code style)
3. `npm test` (validate package and basic functionality)

### Testing Your Changes
1. `npm run lint` (must pass for CI)
2. `npm test` (package validation and unit tests)
3. `npm run test:integration` (full adapter test - takes 40 seconds)

### Key Files to Understand
- **main.js**: Core adapter logic, API communication, device management
- **lib/mapper.js**: Maps Daikin API data to ioBroker state objects and handles data transformations
- **io-package.json**: Adapter metadata, default states, and ioBroker configuration
- **admin/jsonConfig.json**: Admin UI configuration for user settings

## Validation Scenarios

After making changes, ALWAYS validate these scenarios:
1. **Package integrity**: `npm test` must pass completely
2. **Lint compliance**: `npm run lint` must show no errors  
3. **Integration startup**: `npm run test:integration` must complete successfully
4. **TypeScript checks**: `npm run check` will show expected errors in main.js - this is normal

## CI/CD Pipeline

The GitHub Actions workflow (.github/workflows/test-and-release.yml):
- Tests on Node.js 18.x, 20.x, 22.x, 24.x
- Tests on Ubuntu, Windows, macOS
- Runs lint, package tests, and integration tests
- Automatically publishes to NPM on tagged releases

## Authentication Flow

The adapter requires:
1. Daikin Developer Account (developer.cloud.daikineurope.com)
2. Client ID and Client Secret from Daikin Developer Portal
3. OAuth authentication flow through admin interface
4. Tokens are stored encrypted in ioBroker configuration

## Error Handling Notes

- Rate limit errors pause communication temporarily
- Authentication errors require re-authentication
- Device communication errors are logged but don't crash the adapter
- Network timeouts are set to 10 seconds for API calls