/// <reference path="ir.ts" />
/// <reference path="defuse.ts" />
/// <reference path="scope.ts" />
/// <reference path="lift.ts" />

// Given tables of Procs and Procs, index them by their containing Progs.
// Return:
// - A list of unquoted Procs.
// - A table of lists of quoted Procs, indexed by the Prog ID.
// (Quoted progs are already listed in the `subprograms` field.
function group_by_prog(procs: Proc[], progs: Prog[], scopes: number[]): [number[], number[][]] {
  // Initialize the tables for quoted procs and progs.
  let quoted: number[][] = [];
  for (let prog of progs) {
    if (prog !== undefined) {
      quoted[prog.id] = [];
    }
  }

  // Insert each proc where it goes.
  let toplevel: number[] = [];
  for (let proc of procs) {
    if (proc !== undefined) {
      let quote_id = proc.quote_parent;
      if (quote_id === null) {
        toplevel.push(proc.id);
      } else {
        quoted[quote_id].push(proc.id);
      }
    }
  }

  return [toplevel, quoted];
}

// Find all the `extern`s in a program.
type FindExterns = ASTFold<string[]>;
function gen_find_externs(fself: FindExterns): FindExterns {
  let fold_rules = ast_fold_rules(fself);
  let rules = compose_visit(fold_rules, {
    visit_extern(tree: ExternNode, externs: string[]): string[] {
      let e = externs.slice(0);
      e[tree.id] = tree.expansion || tree.name;
      return e;
    }
  });
  return function (tree: SyntaxNode, externs: string[]): string[] {
    return ast_visit(rules, tree, externs);
  };
}
let find_externs = fix(gen_find_externs);

// This is the semantic analysis that produces our mid-level IR given an
// elaborated, desugared AST.
function semantically_analyze(tree: SyntaxNode,
  type_table: TypeTable, intrinsics: TypeMap = {}): CompilerIR
{
  // Give IDs to the intrinsics and add them to the type table.
  let intrinsics_map: NameMap = {};
  for (let name in intrinsics) {
    let id = type_table.length;
    type_table[id] = [intrinsics[name], null];
    intrinsics_map[name] = id;
  }

  // Find scopes.
  let scopes = find_scopes(tree);

  // Use the current intrinsics to build the def/use table.
  // TODO It would be nicer if the def/use pass could just ignore the externs
  // since we find them separately, below.
  let defuse = find_def_use(tree, intrinsics_map);

  // Find the "real" externs in the program, and add the intrinsics to the
  // map.
  let externs = find_externs(tree, []);
  for (let name in intrinsics_map) {
    let id = intrinsics_map[name];
    externs[id] = name;
  }

  // TODO
  let [procs, main, progs] = lift(tree, defuse, scopes, index_tree(tree));

  // Prog-to-Proc mapping.
  // TODO remove this
  let [toplevel_procs, quoted_procs] = group_by_prog(procs, progs, scopes);

  return {
    defuse: defuse,
    procs: procs,
    progs: progs,
    main: main,
    toplevel_procs: toplevel_procs,
    quoted_procs: quoted_procs,
    type_table: type_table,
    externs: externs,
    scopes: scopes,
  };
}
