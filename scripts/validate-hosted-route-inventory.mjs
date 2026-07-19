#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultHostRoot = resolve(repoRoot, '../../sites/gscdump.com')
const snapshotPath = resolve(repoRoot, 'docs/hosted-api-inventory.json')

const args = process.argv.slice(2)
let hostRoot = defaultHostRoot
let mode = 'check'

for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === '--host-root') {
    hostRoot = resolve(process.cwd(), requireValue(args, ++index, argument))
  }
  else if (argument === '--print') {
    mode = 'print'
  }
  else if (argument === '--write') {
    mode = 'write'
  }
  else if (argument === '--check') {
    mode = 'check'
  }
  else if (argument === '--help' || argument === '-h') {
    console.log(`Usage: node scripts/validate-hosted-route-inventory.mjs [options]

Options:
  --check             Compare the generated inventory with the checked-in snapshot (default)
  --print             Print the generated inventory to stdout
  --write             Replace the checked-in snapshot with the generated inventory
  --host-root <path>  Path to the gscdump.com checkout
  --help              Show this help`)
    process.exit(0)
  }
  else {
    fail(`Unknown argument: ${argument}`)
  }
}

const inventory = await buildInventory()
const serialized = `${JSON.stringify(inventory, null, 2)}\n`

if (mode === 'print') {
  process.stdout.write(serialized)
}
else if (mode === 'write') {
  await writeFile(snapshotPath, serialized)
  console.log(`Wrote hosted route inventory (${inventory.summary.operationCount} operations, ${inventory.summary.descriptorCount} descriptors).`)
}
else {
  let checkedIn
  try {
    checkedIn = await readFile(snapshotPath, 'utf8')
  }
  catch (error) {
    fail(`Cannot read ${portable(relative(repoRoot, snapshotPath))}: ${error.message}`)
  }

  if (checkedIn !== serialized) {
    fail([
      'Hosted route inventory is stale.',
      `Inspect the current inventory with: node scripts/validate-hosted-route-inventory.mjs --print --host-root ${hostRoot}`,
      'Update docs/hosted-api-inventory.json deliberately and review the semantic diff.',
    ].join('\n'))
  }

  console.log(`Hosted route inventory is current (${inventory.summary.operationCount} operations, ${inventory.summary.descriptorCount} descriptors).`)
}

async function buildInventory() {
  await assertDirectory(resolve(hostRoot, 'server/api'))

  const routeDefinitions = await parseRouteDefinitions(resolve(repoRoot, 'packages/contracts/src/routes.ts'))
  const legacyDescriptors = await parseEndpointDescriptors(
    resolve(repoRoot, 'packages/contracts/src/endpoints.ts'),
    routeDefinitions,
  )
  const v1Descriptors = await parseV1OpenApiDescriptors()
  const v1DescriptorIds = new Set(v1Descriptors.map(descriptor => descriptor.id))
  const descriptors = [...legacyDescriptors, ...v1Descriptors]
    .sort((left, right) => left.id.localeCompare(right.id))
  const { operations, helperFiles } = await collectApiOperations()
  const { websocketOperations, otherServerRoutes } = await collectServerRoutes()
  const allOperations = [...operations, ...websocketOperations]
    .sort(compareOperation)

  const descriptorsByOperation = new Map()
  for (const descriptor of descriptors) {
    const key = operationKey(descriptor.method, descriptor.path)
    const owners = descriptorsByOperation.get(key) ?? []
    owners.push(descriptor.id)
    descriptorsByOperation.set(key, owners)
  }

  const routeBuildersByOperation = new Map()
  for (const definition of routeDefinitions.values()) {
    const methodIndependentKey = normalizePath(definition.hostPath)
    const owners = routeBuildersByOperation.get(methodIndependentKey) ?? []
    owners.push(definition.id)
    routeBuildersByOperation.set(methodIndependentKey, owners)
  }

  for (const operation of allOperations) {
    operation.descriptorOwners = (descriptorsByOperation.get(operationKey(operation.method, operation.path)) ?? []).sort()
    operation.routeBuilderOwners = (routeBuildersByOperation.get(normalizePath(operation.path)) ?? []).sort()
    const classification = classifyOperation(operation, v1DescriptorIds)
    operation.currentSurface = classification.currentSurface
    operation.v1Review = classification.v1Review
  }

  const operationKeys = new Set(allOperations.map(operation => operationKey(operation.method, operation.path)))
  for (const descriptor of descriptors) {
    descriptor.handlerFiles = allOperations
      .filter(operation => operationKey(operation.method, operation.path) === operationKey(descriptor.method, descriptor.path))
      .map(operation => operation.file)
      .sort()
  }

  const descriptorGroups = new Map()
  for (const descriptor of descriptors) {
    const key = operationKey(descriptor.method, descriptor.path)
    const group = descriptorGroups.get(key) ?? []
    group.push(descriptor)
    descriptorGroups.set(key, group)
  }
  const descriptorCollisions = [...descriptorGroups.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      method: group[0].method,
      path: group[0].path,
      descriptorIds: group.map(descriptor => descriptor.id).sort(),
      handlerFiles: [...new Set(group.flatMap(descriptor => descriptor.handlerFiles))].sort(),
    }))
    .sort(compareOperation)

  const hostOperationsWithoutDescriptor = allOperations
    .filter(operation => operation.descriptorOwners.length === 0)
    .map(operation => ({ method: operation.method, path: operation.path, file: operation.file }))

  const descriptorIdsWithoutHandler = descriptors
    .filter(descriptor => !operationKeys.has(operationKey(descriptor.method, descriptor.path)))
    .map(descriptor => descriptor.id)
    .sort()

  const schemaLessDescriptorIds = descriptors
    .filter(descriptor => descriptor.schema === 'missing')
    .map(descriptor => descriptor.id)
    .sort()

  const unownedV1Operations = allOperations
    .filter(operation => /^\/api\/(?:analytics|partner|realtime)\/v1(?:\/|$)/.test(operation.path))
    .filter(operation => !operation.descriptorOwners.some(id => v1DescriptorIds.has(id)))
  if (unownedV1Operations.length > 0) {
    fail(`Public v1 route has no generated descriptor: ${unownedV1Operations
      .map(operation => `${operation.method} ${operation.path}`)
      .join(', ')}`)
  }

  const handlerlessV1Descriptors = v1Descriptors.filter(descriptor => descriptor.handlerFiles.length === 0)
  if (handlerlessV1Descriptors.length > 0) {
    fail(`Generated public v1 descriptor has no hosted route: ${handlerlessV1Descriptors
      .map(descriptor => descriptor.id)
      .join(', ')}`)
  }

  const descriptorOwnedOperationCount = allOperations.filter(operation => operation.descriptorOwners.length > 0).length

  return {
    inventoryVersion: 1,
    scope: {
      description: 'All live Nitro server/api handlers in gscdump.com, plus its legacy user and partner WebSocket handlers. Legacy package descriptors and generated public-v1 operations are matched as ownership evidence; they do not define inventory inclusion.',
      packageRepository: '.',
      hostRepository: 'gscdump.com',
      sources: [
        'packages/contracts/src/routes.ts',
        'packages/contracts/src/endpoints.ts',
        'packages/contracts/generated/openapi.analytics.v1.json',
        'packages/contracts/generated/openapi.partner.v1.json',
        'packages/contracts/generated/openapi.realtime.v1.json',
        'gscdump.com/server/api',
        'gscdump.com/server/routes/ws',
      ],
    },
    summary: {
      apiRouteFileCount: new Set(operations.map(operation => operation.file)).size,
      httpOperationCount: operations.length,
      websocketOperationCount: websocketOperations.length,
      operationCount: allOperations.length,
      descriptorCount: descriptors.length,
      legacyDescriptorCount: legacyDescriptors.length,
      v1DescriptorCount: v1Descriptors.length,
      descriptorOwnedOperationCount,
      hostOperationsWithoutDescriptorCount: hostOperationsWithoutDescriptor.length,
      schemaLessDescriptorCount: schemaLessDescriptorIds.length,
      descriptorWithoutHandlerCount: descriptorIdsWithoutHandler.length,
      descriptorCollisionCount: descriptorCollisions.length,
      excludedHelperFileCount: helperFiles.length,
      excludedNonApiServerRouteCount: otherServerRoutes.length,
    },
    findings: {
      schemaLessDescriptorIds,
      descriptorIdsWithoutHandler,
      descriptorCollisions,
      hostOperationsWithoutDescriptor,
    },
    excluded: {
      helperFiles,
      nonApiServerRoutes: otherServerRoutes,
    },
    descriptors,
    operations: allOperations,
  }
}

async function collectApiOperations() {
  const apiRoot = resolve(hostRoot, 'server/api')
  const files = await walkTypescriptFiles(apiRoot)
  const operations = []
  const helperFiles = []

  for (const absoluteFile of files) {
    const relativeFile = portable(relative(hostRoot, absoluteFile))
    const basename = absoluteFile.split(sep).at(-1)
    const explicitMethod = basename.match(/\.(delete|get|head|options|patch|post|put)\.ts$/i)?.[1]?.toUpperCase()

    if (!explicitMethod && basename.startsWith('_')) {
      helperFiles.push(relativeFile)
      continue
    }

    if (explicitMethod) {
      operations.push({
        file: relativeFile,
        method: explicitMethod,
        path: nitroPath(apiRoot, absoluteFile, true),
      })
      continue
    }

    const genericPath = nitroPath(apiRoot, absoluteFile, false)
    if (genericPath !== '/api/r2-data/{path+}') {
      fail(`Generic server/api route requires an explicit inventory rule: ${relativeFile}`)
    }

    for (const method of ['GET', 'HEAD']) {
      operations.push({ file: relativeFile, method, path: genericPath })
    }
  }

  return {
    operations: operations.sort(compareOperation),
    helperFiles: helperFiles.sort(),
  }
}

async function collectServerRoutes() {
  const serverRoutesRoot = resolve(hostRoot, 'server/routes')
  const files = await walkTypescriptFiles(serverRoutesRoot)
  const websocketOperations = []
  const otherServerRoutes = []

  for (const absoluteFile of files) {
    const relativeFile = portable(relative(hostRoot, absoluteFile))
    const relativeToRoutes = portable(relative(serverRoutesRoot, absoluteFile))
    if (relativeToRoutes === 'ws/partner.ts' || relativeToRoutes === 'ws/user.ts') {
      websocketOperations.push({
        file: relativeFile,
        method: 'WEBSOCKET',
        path: `/${relativeToRoutes.slice(0, -3)}`,
      })
    }
    else {
      otherServerRoutes.push(relativeFile)
    }
  }

  return {
    websocketOperations: websocketOperations.sort(compareOperation),
    otherServerRoutes: otherServerRoutes.sort(),
  }
}

async function parseRouteDefinitions(file) {
  const sourceFile = await parseSourceFile(file)
  const definitions = new Map()

  for (const owner of ['analytics', 'partner']) {
    const variableName = `${owner}Routes`
    const initializer = findVariableInitializer(sourceFile, variableName)
    visitRouteObject(unwrap(initializer), [owner], definitions, owner)
  }

  return definitions
}

function visitRouteObject(node, path, definitions, owner) {
  if (!ts.isObjectLiteralExpression(node)) {
    fail(`Expected route object at ${path.join('.')}`)
  }

  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(`Unsupported route property at ${path.join('.')}`)
    }
    const name = propertyName(property.name)
    const nextPath = [...path, name]
    const value = unwrap(property.initializer)

    if (ts.isObjectLiteralExpression(value)) {
      visitRouteObject(value, nextPath, definitions, owner)
      continue
    }

    const routePath = evaluateRouteValue(value, nextPath.join('.'))
    const hostPath = owner === 'partner' && !routePath.startsWith('/api/') && !routePath.startsWith('/ws/')
      ? `/api${routePath}`
      : routePath
    definitions.set(nextPath.join('.'), {
      id: nextPath.join('.'),
      owner,
      path: routePath,
      hostPath,
    })
  }
}

function evaluateRouteValue(node, id) {
  if (ts.isStringLiteralLike(node))
    return node.text

  if (ts.isArrowFunction(node)) {
    const body = unwrap(node.body)
    if (!ts.isTemplateExpression(body))
      fail(`Route builder ${id} must return a template expression`)

    let output = body.head.text
    for (const span of body.templateSpans) {
      const expression = unwrap(span.expression)
      let parameter
      if (ts.isCallExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'encodeURIComponent'
        && expression.arguments.length === 1
        && ts.isIdentifier(expression.arguments[0])) {
        parameter = expression.arguments[0].text
      }
      else if (ts.isIdentifier(expression)) {
        parameter = expression.text
      }
      else {
        fail(`Unsupported interpolation in route builder ${id}`)
      }
      output += `{${parameter}}${span.literal.text}`
    }
    return output
  }

  fail(`Unsupported route value for ${id}`)
}

async function parseEndpointDescriptors(file, routeDefinitions) {
  const sourceFile = await parseSourceFile(file)
  const descriptors = []

  for (const owner of ['analytics', 'partner']) {
    const variableName = `${owner}Endpoints`
    const object = unwrap(findVariableInitializer(sourceFile, variableName))
    if (!ts.isObjectLiteralExpression(object))
      fail(`Expected endpoint object: ${variableName}`)

    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property))
        fail(`Unsupported endpoint property in ${variableName}`)

      const name = propertyName(property.name)
      const call = unwrap(property.initializer)
      if (!ts.isCallExpression(call)
        || !ts.isIdentifier(call.expression)
        || call.expression.text !== 'defineEndpoint'
        || call.arguments.length !== 3) {
        fail(`Endpoint ${owner}.${name} must use defineEndpoint(method, path, schema)`)
      }

      const [methodNode, routeNode, schemaNode] = call.arguments
      if (!ts.isStringLiteralLike(methodNode))
        fail(`Endpoint ${owner}.${name} has a non-literal method`)

      const routeReference = propertyAccessName(routeNode)
      const definition = routeDefinitions.get(routeReference)
      if (!definition)
        fail(`Endpoint ${owner}.${name} references unknown route ${routeReference}`)

      descriptors.push({
        id: `${owner}.${name}`,
        owner,
        method: methodNode.text,
        path: definition.hostPath,
        routeBuilder: routeReference,
        schema: ts.isIdentifier(schemaNode) && schemaNode.text === 'noSchema' ? 'missing' : 'validated',
        handlerFiles: [],
      })
    }
  }

  return descriptors.sort((left, right) => left.id.localeCompare(right.id))
}

async function parseV1OpenApiDescriptors() {
  const descriptors = []
  const specifications = [
    ['analytics-v1', 'packages/contracts/generated/openapi.analytics.v1.json'],
    ['partner-v1', 'packages/contracts/generated/openapi.partner.v1.json'],
    ['realtime-v1', 'packages/contracts/generated/openapi.realtime.v1.json'],
  ]

  for (const [owner, relativeFile] of specifications) {
    const file = resolve(repoRoot, relativeFile)
    let document
    try {
      document = JSON.parse(await readFile(file, 'utf8'))
    }
    catch (error) {
      fail(`Cannot parse generated v1 contract ${relativeFile}: ${error.message}`)
    }

    for (const path of Object.keys(document.paths ?? {}).sort()) {
      const pathItem = document.paths[path]
      for (const method of ['delete', 'get', 'patch', 'post', 'put']) {
        const operation = pathItem?.[method]
        if (!operation)
          continue
        if (typeof operation.operationId !== 'string' || operation.operationId.length === 0)
          fail(`Generated v1 operation ${method.toUpperCase()} ${path} has no operationId`)

        descriptors.push({
          id: operation.operationId,
          owner,
          method: method.toUpperCase(),
          path,
          routeBuilder: null,
          schema: 'validated',
          handlerFiles: [],
        })
      }
    }
  }

  return descriptors
}

function classifyOperation(operation, v1DescriptorIds) {
  if (operation.method === 'WEBSOCKET')
    return { currentSurface: 'legacy-realtime', v1Review: 'replace-realtime' }
  if (/^\/api\/(?:analytics|partner|realtime)\/v1(?:\/|$)/.test(operation.path)) {
    const hasV1Owner = operation.descriptorOwners.some(id => v1DescriptorIds.has(id))
    return {
      currentSurface: `public-${operation.path.split('/')[2]}-v1`,
      v1Review: hasV1Owner ? 'accepted-v1' : 'unowned-v1',
    }
  }
  if (operation.path.startsWith('/api/__gsc'))
    return { currentSurface: 'legacy-analytics-data', v1Review: 'analytics' }
  if (operation.path.startsWith('/api/partner'))
    return { currentSurface: 'partner-control', v1Review: 'partner' }
  if (operation.descriptorOwners.some(id => id.startsWith('analytics.')))
    return { currentSurface: 'shared-hosted', v1Review: 'analytics' }
  if (operation.descriptorOwners.some(id => id.startsWith('partner.')))
    return { currentSurface: 'shared-hosted', v1Review: 'partner' }
  if (/^\/api\/(?:sites|sync-progress|teams|user|users)(?:\/|$)/.test(operation.path))
    return { currentSurface: 'shared-hosted', v1Review: 'decision-required' }
  if (operation.path.startsWith('/api/admin'))
    return { currentSurface: 'host-admin', v1Review: 'outside-public-protocol' }
  if (operation.path.startsWith('/api/cli'))
    return { currentSurface: 'cli', v1Review: 'outside-public-protocol' }
  if (operation.path.startsWith('/api/public'))
    return { currentSurface: 'public-host', v1Review: 'outside-public-protocol' }
  return { currentSurface: 'host-internal-or-session', v1Review: 'outside-public-protocol' }
}

function nitroPath(apiRoot, absoluteFile, hasMethodSuffix) {
  let relativeFile = portable(relative(apiRoot, absoluteFile))
  relativeFile = hasMethodSuffix
    ? relativeFile.replace(/\.(delete|get|head|options|patch|post|put)\.ts$/i, '')
    : relativeFile.replace(/\.ts$/, '')

  const segments = relativeFile.split('/')
  if (segments.at(-1) === 'index')
    segments.pop()

  const routeSegments = segments.map((segment) => {
    const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/)
    if (catchAll)
      return `{${catchAll[1]}+}`
    const parameter = segment.match(/^\[([^\]]+)\]$/)
    if (parameter)
      return `{${parameter[1]}}`
    return segment
  })

  return `/api${routeSegments.length ? `/${routeSegments.join('/')}` : ''}`
}

function operationKey(method, path) {
  return `${method} ${normalizePath(path)}`
}

function normalizePath(path) {
  return path
    .replace(/\{[^}]+\+\}/g, '{+}')
    .replace(/\{[^}]+\}/g, '{}')
}

function compareOperation(left, right) {
  return left.path.localeCompare(right.path) || left.method.localeCompare(right.method) || (left.file ?? '').localeCompare(right.file ?? '')
}

function propertyAccessName(node) {
  node = unwrap(node)
  const names = []
  while (ts.isPropertyAccessExpression(node)) {
    names.unshift(node.name.text)
    node = unwrap(node.expression)
  }
  if (!ts.isIdentifier(node))
    fail('Endpoint route must be a property access expression')
  names.unshift(node.text === 'analyticsRoutes' ? 'analytics' : node.text === 'partnerRoutes' ? 'partner' : node.text)
  return names.join('.')
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
    return node.text
  fail('Computed property names are not supported in hosted contract registries')
}

function findVariableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement))
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer)
        return declaration.initializer
    }
  }
  fail(`Cannot find variable ${name}`)
}

function unwrap(node) {
  while (ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isParenthesizedExpression(node)
    || ts.isTypeAssertionExpression(node)) {
    node = node.expression
  }
  return node
}

async function parseSourceFile(file) {
  const source = await readFile(file, 'utf8')
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

async function walkTypescriptFiles(root) {
  const output = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory())
        await visit(absolute)
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        output.push(absolute)
    }
  }
  await visit(root)
  return output
}

async function assertDirectory(directory) {
  try {
    await readdir(directory)
  }
  catch (error) {
    fail(`Cannot read host checkout at ${directory}: ${error.message}. Pass --host-root <path>.`)
  }
}

function portable(value) {
  return value.split(sep).join('/')
}

function requireValue(values, index, option) {
  const value = values[index]
  if (!value || value.startsWith('--'))
    fail(`${option} requires a value`)
  return value
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
