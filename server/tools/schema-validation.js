const TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

export function validateJsonSchema(schema, value, path = '$', depth = 0) {
  if (depth > 32) return [`${path}: schema nesting limit exceeded`]
  if (!isPlainObject(schema)) return [`${path}: schema must be an object`]
  if (typeof schema.type !== 'string' || !TYPES.has(schema.type)) {
    return [`${path}: schema type is unsupported`]
  }

  const errors = []
  if (!matchesType(schema.type, value)) {
    return [`${path}: expected ${schema.type}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepEqual(item, value))) {
    errors.push(`${path}: value is not an allowed enum member`)
  }

  if (schema.type === 'object') {
    const properties = schema.properties === undefined ? {} : schema.properties
    if (!isPlainObject(properties)) return [`${path}: schema properties must be an object`]
    const required = schema.required === undefined ? [] : schema.required
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
      return [`${path}: schema required must be a string array`]
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required property is missing`)
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateJsonSchema(properties[key], item, `${path}.${key}`, depth + 1))
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property is not allowed`)
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateJsonSchema(schema.additionalProperties, item, `${path}.${key}`, depth + 1))
      }
    }
  } else if (schema.type === 'array' && schema.items !== undefined) {
    if (!isPlainObject(schema.items)) return [`${path}: schema items must be an object`]
    value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`, depth + 1)))
  } else if (schema.type === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path}: string is too short`)
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}: string is too long`)
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: number is below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: number is above maximum`)
  }
  return errors
}

function matchesType(type, value) {
  switch (type) {
    case 'array': return Array.isArray(value)
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return Number.isInteger(value)
    case 'null': return value === null
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'object': return isPlainObject(value)
    case 'string': return typeof value === 'string'
    default: return false
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isDeepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
