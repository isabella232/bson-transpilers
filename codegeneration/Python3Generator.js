const CodeGenerator = require('./CodeGenerator.js');
const {
  Types
} = require('./SymbolTable');

/**
 * This Visitor walks the tree generated by parsers and produces Python code.
 *
 * @returns {object}
 */
function Visitor() {
  CodeGenerator.call(this);

  return this;
}
Visitor.prototype = Object.create(CodeGenerator.prototype);
Visitor.prototype.constructor = Visitor;

// /////////////////////////// //
// Nodes that differ in syntax //
// /////////////////////////// //

/**
 * Visit String Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitStringLiteral = function(ctx) {
  ctx.type = Types._string;

  return this.singleQuoteStringify(this.visitChildren(ctx));
};

/**
 * Visit Property Name And Value List
 *
 * @param {PropertyNameAndValueListContext} ctx
 * @return {String}
 */
Visitor.prototype.visitPropertyNameAndValueList = function(ctx) {
  return this.visitChildren(ctx, {children: ctx.propertyAssignment(), separator: ', '});
};

/**
 * Child nodes: propertyName singleExpression
 * @param {PropertyAssignmentExpressionContext} ctx
 * @return {String}
 */
Visitor.prototype.visitPropertyAssignmentExpression = function(ctx) {
  const key = this.singleQuoteStringify(this.visit(ctx.propertyName()));
  const value = this.visit(ctx.singleExpression());

  return `${key}: ${value}`;
};


/**
 * Because python doesn't need `New`, we can skip the first child
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitNewExpression = function(ctx) {
  const child = this.visitChildren(ctx, {start: 1});

  ctx.type = ctx.singleExpression().type;

  return child;
};

/**
 * Visit Object Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitObjectLiteral = function(ctx) {
  ctx.type = Types._object;

  return this.visitChildren(ctx);
};

/**
 * TODO: Is it okay to sort by terminal?
 * Child nodes: (elision* singleExpression*)+
 *
 * @param {ElementListContext} ctx
 * @return {String}
 */
Visitor.prototype.visitElementList = function(ctx) {
  const children = ctx.children.filter((child) => (
    child.constructor.name !== 'TerminalNodeImpl'
  ));

  return this.visitChildren(ctx, {children, separator: ', '});
};

/**
 * Visit Code Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONCodeConstructor = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null ||
    (
      args.argumentList().getChildCount() !== 1 &&
      args.argumentList().getChildCount() !== 3
    )
  ) {
    return 'Error: Code requires one or two arguments';
  }

  const argList = args.argumentList().singleExpression();
  const code = this.singleQuoteStringify(argList[0].getText());

  if (argList.length === 2) {
    /* NOTE: we have to visit the subtree first before type checking or type may
     not be set. We might have to just suck it up and do two passes, but maybe
     we can avoid it for now. */
    const scope = this.visit(argList[1]);

    if (argList[1].type !== Types._object) {
      return 'Error: Code requires scope to be an object';
    }

    return `Code(${code}, ${scope})`;
  }

  return `Code(${code})`;
};

/**
 * This evaluates the code in a sandbox and gets the hex string out of the
 * ObjectId.
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONObjectIdConstructor = function(ctx) {
  const args = ctx.arguments();

  if (args.argumentList() === null) {
    return 'ObjectId()';
  }

  if (args.argumentList().getChildCount() !== 1) {
    return 'Error: ObjectId requires zero or one argument';
  }

  let hexstr;

  try {
    hexstr = this.executeJavascript(ctx.getText()).toHexString();
  } catch (error) {
    return error.message;
  }

  return `ObjectId(${this.singleQuoteStringify(hexstr)})`;
};

/**
 * Visit Binary Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONBinaryConstructor = function(ctx) {
  const args = ctx.arguments();
  let type = '';
  let binobj = {};
  const subtypes = {
    0: 'bson.binary.BINARY_SUBTYPE',
    1: 'bson.binary.FUNCTION_SUBTYPE',
    2: 'bson.binary.OLD_BINARY_SUBTYPE',
    3: 'bson.binary.OLD_UUID_SUBTYPE',
    4: 'bson.binary.UUID_SUBTYPE',
    5: 'bson.binary.MD5_SUBTYPE',
    6: 'bson.binary.CSHARP_LEGACY',
    128: 'bson.binary.USER_DEFINED_SUBTYPE'
  };

  if (
    args.argumentList() === null ||
    (
      args.argumentList().getChildCount() !== 1 &&
      args.argumentList().getChildCount() !== 3
    )
  ) {
    return 'Error: Binary requires one or two argument';
  }

  try {
    binobj = this.executeJavascript(ctx.getText());
    type = binobj.sub_type;
  } catch (error) {
    return error.message;
  }

  const argList = args.argumentList().singleExpression();
  const bytes = this.singleQuoteStringify(binobj.toString());

  if (argList.length === 1) {
    return `Binary(bytes(${bytes}, 'utf-8'))`;
  }

  return `Binary(bytes(${bytes}, 'utf-8'), ${subtypes[type]})`;
};

/**
 * Visit Double Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONDoubleConstructor = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null || args.argumentList().getChildCount() !== 1
  ) {
    return 'Error: Double requires one argument';
  }

  const arg = args.argumentList().singleExpression()[0];
  const double = this.removeQuotes(this.visit(arg));

  if (
    (
      arg.type !== Types._string &&
      arg.type !== Types._decimal &&
      arg.type !== Types._integer
    ) ||
    isNaN(parseInt(double, 10))
  ) {
    return 'Error: Double requires a number or a string argument';
  }

  return `float(${double})`;
};

/**
 * Visit Long Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONLongConstructor = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null ||
    (
      args.argumentList().getChildCount() !== 1 &&
      args.argumentList().getChildCount() !== 3
    )
  ) {
    return 'Error: Long requires one or two argument';
  }

  let longstr = '';

  try {
    longstr = this.executeJavascript(ctx.getText()).toString();
  } catch (error) {
    return error.message;
  }

  return `Int64(${longstr})`;
};

/**
 * Visit Date Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitDateConstructorExpression = function(ctx) {
  const args = ctx.arguments();

  if (args.argumentList() === null) {
    return 'datetime.datetime.utcnow().date()';
  }

  let dateStr = '';

  try {
    const date = this.executeJavascript(ctx.getText());

    dateStr = [
      date.getUTCFullYear(),
      (date.getUTCMonth() + 1),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds()
    ].join(', ');
  } catch (error) {
    return error.message;
  }

  return `datetime.datetime(${dateStr}, tzinfo=datetime.timezone.utc)`;
};

/**
 * Visit Date Now Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitDateNowConstructorExpression = function() {
  return 'datetime.datetime.utcnow()';
};

/**
 * Visit Number Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitNumberConstructorExpression = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null || args.argumentList().getChildCount() !== 1
  ) {
    return 'Error: Number requires one argument';
  }

  const arg = args.argumentList().singleExpression()[0];
  const number = this.removeQuotes(this.visit(arg));

  if (
    (
      args.type !== Types._string &&
      args.type !== Types._decimal &&
      args.type !== Types._integer
    ) ||
    isNaN(parseInt(number, 10))
  ) {
    return 'Error: Number requires a number or a string argument';
  }

  return `int(${number})`;
};

/**
 * Visit MaxKey Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONMaxKeyConstructor = function() {
  return 'MaxKey()';
};

/**
 * Visit MinKey Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONMinKeyConstructor = function() {
  return 'MinKey()';
};

/**
 * Visit Symbol Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONSymbolConstructor = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null || args.argumentList().getChildCount() !== 1
  ) {
    return 'Error: Symbol requires one argument';
  }

  const arg = args.argumentList().singleExpression()[0];
  const symbol = this.visit(arg);

  if (arg.type !== Types._string) {
    return 'Error: Symbol requires a string argument';
  }

  return `unicode(${symbol}, 'utf-8')`;
};

/**
 * Visit Object.create() Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitObjectCreateConstructorExpression = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null || args.argumentList().getChildCount() !== 1
  ) {
    return 'Error: Object.create() requires one argument';
  }

  const arg = args.argumentList().singleExpression()[0];
  const obj = this.visit(arg);

  if (arg.type !== Types._object) {
    return 'Error: Object.create() requires an object argument';
  }

  return obj;
};

/**
 * Visit Array Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitArrayLiteral = function(ctx) {
  ctx.type = this.types.ARRAY;

  return this.visitChildren(ctx);
};

/**
 * Visit Undefined Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitUndefinedLiteral = function(ctx) {
  ctx.type = this.types.UNDEFINED;

  return 'None';
};

/**
 * Visit Elision Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitElision = function(ctx) {
  ctx.type = this.types.NULL;

  return 'None';
};

/**
 * Visit Null Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitNullLiteral = function(ctx) {
  ctx.type = this.types.NULL;

  return 'None';
};

/**
 * Visit Octal Integer Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitOctalIntegerLiteral = function(ctx) {
  ctx.type = this.types.OCTAL;

  let oct = this.visitChildren(ctx);
  let offset = 0;

  if (
    oct.charAt(0) === '0' &&
    (oct.charAt(1) === '0' || oct.charAt(1) === 'o' || oct.charAt(1) === 'O')
  ) {
    offset = 2;
  } else if (oct.charAt(0) === '0') {
    offset = 1;
  }

  oct = `0o${oct.substr(offset, oct.length - 1)}`;

  return oct;
};

/**
 * Visit BSON Timestamp Constructor
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBSONTimestampConstructor = function(ctx) {
  const args = ctx.arguments();

  if (
    args.argumentList() === null || args.argumentList().getChildCount() !== 3
  ) {
    return 'Error: Timestamp requires two arguments';
  }

  const argList = args.argumentList().singleExpression();
  const low = this.visit(argList[0]);

  if (argList[0].type !== this.types.INTEGER) {
    return 'Error: Timestamp first argument requires integer arguments';
  }

  const high = this.visit(argList[1]);

  if (argList[1].type !== this.types.INTEGER) {
    return 'Error: Timestamp second argument requires integer arguments';
  }

  return `Timestamp(${low}, ${high})`;
};

/**
 * Visit Boolean Literal Literal
 *
 * @param {object} ctx
 * @returns {string}
 */
Visitor.prototype.visitBooleanLiteral = function(ctx) {
  ctx.type = this.types.BOOL;

  const string = ctx.getText();

  return `${string.charAt(0).toUpperCase()}${string.slice(1)}`;
};

/**
 * child nodes: arguments
 * grandchild nodes: argumentList?
 * great-grandchild nodes: singleExpression+
 * @param {RegExpConstructorExpressionContext} ctx
 * @return {String}
 */
Visitor.prototype.visitRegExpConstructorExpression =
Visitor.prototype.visitRegularExpressionLiteral = function(ctx) {
  const PYTHON_REGEX_FLAGS = {
    i: 'i', // re.IGNORECASE
    m: 'm', // re.MULTILINE
    u: 'a', // re.ASCII
    y: '', // Sticky flag matches only from the index indicated by the lastIndex property
    g: 's' // re.DOTALL matches all
    // re.DEBUG - Display debug information. No corresponding inline flag.
    // re.LOCALE - Case-insensitive matching dependent on the current locale. Inline flag (?L)
    // re.VERBOSE - More readable way of writing patterns (eg. with comments)
  };

  let pattern;
  let flags;

  try {
    const regexobj = this.executeJavascript(ctx.getText());

    pattern = regexobj.source;
    flags = regexobj.flags;
  } catch (error) {
    return error.message;
  }

  // Double escape characters except for slashes
  const escaped = pattern.replace(/\\(?!\/)/, '\\\\');

  if (flags !== '') {
    flags = flags
      .split('')
      .map((item) => PYTHON_REGEX_FLAGS[item])
      .sort()
      .join('');

    return `re.compile(r${this.doubleQuoteStringify(`${escaped}(?${flags})`)})`;
  }

  return `re.compile(r${this.doubleQuoteStringify(escaped)})`;
};

/**
 * Expects two strings as arguments, the second must be valid flag
 *
 * child nodes: arguments
 * grandchild nodes: argumentList?
 * great-grandchild nodes: singleExpression+
 * @param {BSONRegExpConstructorContext} ctx
 * @return {String}
 */
Visitor.prototype.visitBSONRegExpConstructor = function(ctx) {
  const argList = ctx.arguments().argumentList();
  const BSON_FLAGS = {
    'i': 'i', // Case insensitivity to match
    'm': 'm', // Multiline match
    'x': 'x', // Ignore all white space characters
    's': 's', // Matches all
    'l': 'l', // Case-insensitive matching dependent on the current locale?
    'u': 'u' // Unicode?
  };

  if (
    argList === null ||
    (argList.getChildCount() !== 1 && argList.getChildCount() !== 3)
  ) {
    return 'Error: BSONRegExp requires one or two arguments';
  }

  const args = argList.singleExpression();
  const pattern = this.visit(args[0]);

  if (args[0].type !== this.types.STRING) {
    return 'Error: BSONRegExp requires pattern to be a string';
  }

  if (args.length === 2) {
    let flags = this.visit(args[1]);

    if (args[1].type !== this.types.STRING) {
      return 'Error: BSONRegExp requires flags to be a string';
    }

    if (flags !== '') {
      const unsuppotedFlags = [];

      flags = this
        .removeQuotes(flags).split('')
        .map((item) => {
          if (Object.keys(BSON_FLAGS).includes(item) === false) {
            unsuppotedFlags.push(item);
          }

          return BSON_FLAGS[item];
        });

      if (unsuppotedFlags.length > 0) {
        return `Error: the regular expression contains unsuppoted '${unsuppotedFlags.join('')}' flag`;
      }

      flags = this.singleQuoteStringify(flags.join(''));
    }

    return `RegExp(${pattern}, ${flags})`;
  }
  return `RegExp(${pattern})`;
};

/**
 * child nodes: arguments
 * grandchild nodes: argumentList?
 * great-grandchild nodes: singleExpression+
 *
 * @param {BSONDBRefConstructorContext} ctx
 * @return {String}
 */
Visitor.prototype.visitBSONDBRefConstructor = function(ctx) {
  const argList = ctx.arguments().argumentList();

  if (
    argList === null ||
    (argList.getChildCount() !== 3 && argList.getChildCount() !== 5)
  ) {
    return 'Error: DBRef requires two or three arguments';
  }

  const args = argList.singleExpression();
  const ns = this.visit(args[0]);

  if (args[0].type !== this.types.STRING) {
    return 'Error: DBRef first argumnet requires string namespace';
  }

  const oid = this.visit(args[1]);

  if (args[1].type !== this.types.OBJECT) {
    return 'Error: DBRef requires object OID';
  }

  if (args.length === 3) {
    const db = this.visit(args[2]);

    if (args[2].type !== this.types.STRING) {
      return 'Error: DbRef requires string collection';
    }

    return `DBRef(${ns}, ${oid}, ${db})`;
  }

  return `DBRef(${ns}, ${oid})`;
};

/**
 * Visit an error node, and return a user-defined result of the operation
 *
 * @param {object} ctx
 * @returns {String}
 */

Visitor.prototype.visitErrorNode = function(ctx) {
  return ctx.getText();
};

module.exports = Visitor;
