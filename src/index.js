const fs = require("fs");
const path = require("path");
const traverse = require("traverse");
const { get, has, find } = require("lodash");

/**
 * Return an Array of every possible non-cyclic path in the object as a dot separated string sorted
 * by length.
 *
 * Example:
 * getSortedObjectPaths({ process: { env: { NODE_ENV: "development" } } });
 * // => [ "process.env.NODE_ENV", "process.env" "process" ]
 *
 * @param  {Object}  obj  A plain JavaScript Object
 * @return {Array}  Sorted list of non-cyclic paths into obj
 */
export const getSortedObjectPaths = (obj) => {
  if (!obj) { return []; }

  return traverse(obj)
    .paths()
    .filter((arr) => arr.length)
    .map((arr) => arr.join("."))
    .sort((elem) => elem.length);
};

/**
 *  `babel-plugin-transfor-define` take options of two types: static config and a path to a file that
 *  can define config in any way a user sees fit. getReplacements takes the options and will either
 *  return the static config or get the dynamic config from disk
 * @param  {Object|String}  configOptions  configuration to parse
 * @return {Object}  replacement object
 */
const getReplacements = (configOptions) => {
  if (typeof configOptions === "object") { return configOptions; }

  try {
    const fullPath = path.join(process.cwd(), configOptions);
    fs.accessSync(fullPath, fs.F_OK);
    return require(fullPath);
  } catch (err) {
    console.error(`The nodePath: ${configOptions} is not valid.`); // eslint-disable-line
    throw new Error(err);
  }
};

/**
 * Replace a node with a given value. If the replacement results in a BinaryExpression, it will be
 * evaluated. For example, if the result of the replacement is `var x = "production" === "production"`
 * The evaluation will make a second replacement resulting in `var x = true`
 * @param  {function}   replaceFn    The function used to replace the node
 * @param  {babelNode}  nodePath     The node to evaluate
 * @param  {*}          replacement  The value the node will be replaced with
 * @return {undefined}
 */
const replaceAndEvaluateNode = (replaceFn, nodePath, replacement) => {
  nodePath.replaceWith(replaceFn(replacement));

  if (nodePath.parentPath.isBinaryExpression()) {
    const result = nodePath.parentPath.evaluate();

    if (result.confident) {
      nodePath.parentPath.replaceWith(replaceFn(result.value));
    }
  }
};
/**
 * Finds the first replacement in sorted object paths for replacements that causes comparator
 * to return true.  If one is found, replaces the node with it.
 * @param  {Object}     replacements The object to search for replacements
 * @param  {babelNode}  nodePath     The node to evaluate
 * @param  {function}   replaceFn    The function used to replace the node
 * @param  {function}   comparator   The function used to evaluate whether a node matches a value in `replacements`
 * @return {undefined}
 */
const processNode = (replacements, nodePath, replaceFn, comparator) => { // eslint-disable-line
  const replacementKey = find(getSortedObjectPaths(replacements),
    (value) => comparator(nodePath, value));
  if (has(replacements, replacementKey)) {
    replaceAndEvaluateNode(replaceFn, nodePath, get(replacements, replacementKey));
  }
};

/**
 * Change the name of imported name of ImportDeclaration node (may be a partial change)
 * @param {string}    replacement     The replacement string for import imported name
 * @param {string}    replacementKey  The text to replace
 * @param {babelNode} nodePath        The node to evaluate
 * @param {babelType} t               The babel type for cloning node
 * @return {undefined}
 */
const processImportNameNode = (replacement, replacementKey, nodePath, t) => { // eslint-disable-line
  // Modif des nom d'imports
  const specifiers = nodePath.get("specifiers").filter((aPath) => t.isImportSpecifier(aPath));
  for (const specifier of specifiers) {
    const specifierReplacement = t.clone(specifier);
    const imported = specifierReplacement.node.imported;
    if (imported && imported.name.indexOf(replacementKey) >= 0) {
      const newSourceName = imported.name.replace(replacementKey, replacement);
      console.log("Change ", imported.name, "for", newSourceName);
      imported.loc.identifierName = imported.loc.identifierName.replace(replacementKey, replacement);
      imported.name = newSourceName;
      specifier.replaceWith(
        specifierReplacement.node
      );
    }
  }
};

/**
 * Change the path of imported source of ImportDeclaration node (may be a partial change)
 * @param {string}    replacement     The replacement string for import imported name
 * @param {string}    replacementKey  The text to replace
 * @param {babelNode} nodePath        The node to evaluate
 * @param {babelType} t               The babel type for cloning node
 * @return {undefined}
 */
const processSourceImportNode = (replacement, replacementKey, nodePath, t) => { // eslint-disable-line
  const sourceNode = nodePath.get("source");
  const newSource = t.clone(sourceNode);
  const newSourceNode = newSource.node;
  const newSourceValue = newSourceNode.value.replace(replacementKey, replacement);
  console.log("Change", newSourceNode.value, "for", newSourceValue);
  newSourceNode.value = newSourceValue;
  for (const item in newSource.node.extra) {
    newSourceNode.extra[item] = newSourceNode.extra[item].replace(replacementKey, replacement);
  }
  sourceNode.replaceWith(newSourceNode);
};

const memberExpressionComparator = (nodePath, value) => nodePath.matchesPattern(value);
const identifierComparator = (nodePath, value) => nodePath.node.name === value;
const unaryExpressionComparator = (nodePath, value) => nodePath.node.argument.name === value;
const importDeclarationComparator = (nodePath, value) => nodePath.node.source.value.match(value);
const importAliasComparator = (nodePath, value) => {
  const specifiers = nodePath.get("specifiers");
  const importedSpecifiers = specifiers.filter((aPath) => aPath.node.imported !== undefined);
  return importedSpecifiers.find((aPath) => aPath.node.imported.name.match(value)) !== undefined;
};

const getReplacementKey = (nodePath, list, comparator) => find(list, (value) => comparator(nodePath, value));

export default function ({ types: t }) {
  return {
    visitor: {
      ImportDeclaration(nodePath, state) {
        const replacements = getReplacements(state.opts);
        const replacementList = getSortedObjectPaths(replacements);

        // Recherche de variable dans le nom (specifier) des imports
        let replacementKey = getReplacementKey(nodePath, replacementList, importAliasComparator);
        if (has(replacements, replacementKey)) {
          const replacement = get(replacements, replacementKey);
          processImportNameNode(replacement, replacementKey, nodePath, t);
        }

        // Recherche de variable dans la source des imports
        replacementKey = getReplacementKey(nodePath, replacementList, importDeclarationComparator);
        if (has(replacements, replacementKey)) {
          const replacement = get(replacements, replacementKey);
          processSourceImportNode(replacement, replacementKey, nodePath, t);
        }
      },
      // process.env.NODE_ENV;
      MemberExpression(nodePath, state) {
        processNode(getReplacements(state.opts), nodePath, t.valueToNode, memberExpressionComparator);
      },
      // const x = { version: VERSION };
      Identifier(nodePath, state) {
        processNode(getReplacements(state.opts), nodePath, t.valueToNode, identifierComparator);
      },
      // typeof window
      UnaryExpression(nodePath, state) {
        if (nodePath.node.operator !== "typeof") { return; }

        const replacements = getReplacements(state.opts);
        const keys = Object.keys(replacements);
        const typeofValues = {};

        keys.forEach((key) => {
          if (key.substring(0, 7) === "typeof ") {
            typeofValues[key.substring(7)] = replacements[key];
          }
        });

        processNode(typeofValues, nodePath, t.valueToNode, unaryExpressionComparator);
      }
    }
  };
}
