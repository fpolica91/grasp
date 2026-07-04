// grasp Babel instrument plugin — wraps every function in a target file so a real run
// records enter / return / throw / exit into globalThis.__grasp. No values are invented:
// only actual argument bindings and actual return/throw values are captured.
module.exports = function graspTrace({ types: t }) {
  const G = t.memberExpression(t.identifier('globalThis'), t.identifier('__grasp'))
  const call = (method, args) => t.callExpression(t.memberExpression(G, t.identifier(method)), args)

  // best-effort function name from the node / its binding context
  function nameOf(path) {
    const n = path.node
    if (n.id && n.id.name) return n.id.name
    const p = path.parent
    if (t.isVariableDeclarator(p) && p.id.name) return p.id.name
    if (t.isObjectProperty(p) && p.key) return p.key.name || p.key.value
    if (t.isClassMethod(n) && n.key) return n.key.name || n.key.value
    if (t.isAssignmentExpression(p) && t.isIdentifier(p.left)) return p.left.name
    return '(anonymous)'
  }

  // { a, b } object literal from simple identifier params (destructured/default skipped —
  // honest: we bind what we can name, never a guess)
  function argsObject(params) {
    const props = []
    for (const pm of params) {
      if (t.isIdentifier(pm)) props.push(t.objectProperty(t.stringLiteral(pm.name), t.identifier(pm.name), false, false))
      else if (t.isAssignmentPattern(pm) && t.isIdentifier(pm.left))
        props.push(t.objectProperty(t.stringLiteral(pm.left.name), t.identifier(pm.left.name), false, false))
    }
    return t.objectExpression(props)
  }

  function instrument(path, state) {
    const n = path.node
    if (n.__grasped) return
    const file = state.file.opts.filename || '?'
    const line = (n.loc && n.loc.start.line) || 0
    const name = nameOf(path)

    // arrow with expression body -> block body so we can wrap it
    if (t.isArrowFunctionExpression(n) && !t.isBlockStatement(n.body)) {
      n.body = t.blockStatement([t.returnStatement(n.body)])
    }
    if (!t.isBlockStatement(n.body)) return

    n.__grasped = true
    const enter = t.expressionStatement(
      call('enter', [t.stringLiteral(name), argsObject(n.params), t.stringLiteral(file), t.numericLiteral(line)])
    )
    const tryStmt = t.tryStatement(
      t.blockStatement(n.body.body),
      t.catchClause(
        t.identifier('__ge'),
        t.blockStatement([t.expressionStatement(call('thrown', [t.identifier('__ge')])), t.throwStatement(t.identifier('__ge'))])
      ),
      t.blockStatement([t.expressionStatement(call('exit', []))])
    )
    n.body = t.blockStatement([enter, tryStmt])
  }

  return {
    name: 'grasp-trace',
    visitor: {
      'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ObjectMethod': instrument,
      // record the returned value (and pass it through unchanged)
      ReturnStatement(path) {
        if (path.node.__graspRet || !path.node.argument) return
        path.node.__graspRet = true
        path.node.argument = call('ret', [path.node.argument])
      }
    }
  }
}
