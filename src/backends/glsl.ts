/// <reference path="../visit.ts" />
/// <reference path="../util.ts" />
/// <reference path="../compile/compile.ts" />
/// <reference path="emitutil.ts" />
/// <reference path="../type.ts" />

// Special GLSL matrix and vector types.
// Someday, a more structured notion of generic vector and matrix types would
// be better. For now, we just support a handful of common types.
const FLOAT3 = new PrimitiveType("Float3");
const FLOAT4 = new PrimitiveType("Float4");
const FLOAT3X3 = new PrimitiveType("Float3x3");
const FLOAT4X4 = new PrimitiveType("Float4x4");
const ARRAY = new ConstructorType("Array");
const INT3 = new PrimitiveType("Int3");
const INT4 = new PrimitiveType("Int4");

const GL_TYPES: TypeMap = {
  "Float3": FLOAT3,
  "Float4": FLOAT4,
  "Vec3": FLOAT3,  // Convenient OpenGL-esque names.
  "Vec4": FLOAT4,
  "Float3x3": FLOAT3X3,
  "Float4x4": FLOAT4X4,
  "Mat3": FLOAT3X3,
  "Mat4": FLOAT4X4,
  "Int3": INT3,
  "Int4": INT4,
  "Array": ARRAY,

  // TODO This Mesh type is used by the dingus. It is an opaque type. It would
  // be nice if the dingus could declare the Mesh type itself rather than
  // needing to bake it in here.
  "Mesh": new PrimitiveType("Mesh"),
};

module Backends.GLSL {

const NUMERIC_TYPES: Type[] = [
  FLOAT3, FLOAT4,
  FLOAT3X3, FLOAT4X4,
  INT3, INT4,
];

const TYPE_NAMES: { [_: string]: string } = {
  "Int": "int",
  "Int3": "ivec3",
  "Int4": "ivec4",
  "Float": "float",
  "Float3": "vec3",
  "Float4": "vec4",
  "Float3x3": "mat3",
  "Float4x4": "mat4",
};

// A naming convention for global communication (uniform/attribute/varying)
// variables in shaders. The `scopeid` is the ID of the quote where the
// variable is used. `exprid` is the ID of the variable or persist scape
// expression.
export function shadervarsym(scopeid: number, varid: number) {
  return "s" + scopeid + "v" + varid;
}


// Checking for our magic `vtx` and `frag` intrinsics, which indicate the
// structure of shader programs.
// This could be more efficient by using the ID of the extern. For now, we
// just match on the name.

function is_intrinsic(tree: CallNode, name: string) {
  if (tree.fun.tag === "lookup") {
    let fun = <LookupNode> tree.fun;
    return fun.ident === name;
  }
  return false;
}

export function is_intrinsic_call(tree: ExpressionNode, name: string) {
  if (tree.tag === "call") {
    return is_intrinsic(tree as CallNode, name);
  }
  return false;
}

function frag_expr(tree: ExpressionNode) {
  return is_intrinsic_call(tree, "frag");
}

function emit_extern(name: string, type: Type): string {
  return name;
}


// Type checking for uniforms, which are automatically demoted from arrays to
// individual values when they persist.

// A helper function that unwraps array types. Non-array types are unaffected.
export function _unwrap_array(t: Type): Type {
  if (t instanceof InstanceType) {
    if (t.cons === ARRAY) {
      // Get the inner type: the array element type.
      return t.arg;
    }
  }
  return t;
}

// The type mixin itself.
export function type_mixin(fsuper: TypeCheck): TypeCheck {
  let type_rules = complete_visit(fsuper, {
    // The goal here is to take lookups into prior stages of type `X Array`
    // and turn them into type `X`.
    visit_lookup(tree: LookupNode, env: TypeEnv): [Type, TypeEnv] {
      // Look up the type and stage of a variable.
      let [stack, anns, _, __] = env;
      if (anns[0] === "s") {  // Shader stage.
        let [t, pos] = stack_lookup(stack, tree.ident);
        if (t !== undefined && pos > 0) {
          return [_unwrap_array(t), env];
        }
      }

      return fsuper(tree, env);
    },

    // Do the same for ordinary persist-escapes.
    // This is one downside of our desugaring: we have two cases here instead
    // of just one (cross-stage variable references). We need this even to
    // type-elaborate the subtrees generated by desugaring.
    visit_escape(tree: EscapeNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = fsuper(tree, env);
      let [_, anns, __, ___] = env;
      if (anns[0] === "s") {  // Shader stage.
        if (tree.kind === "persist") {
          return [_unwrap_array(t), e];
        }
      }
      return [t, e];
    },
  });

  return function (tree: SyntaxNode, env: TypeEnv): [Type, TypeEnv] {
    return ast_visit(type_rules, tree, env);
  };
};


// The core compiler rules for emitting GLSL code.

export type Compile = (tree: SyntaxNode) => string;
export function compile_rules(fself: Compile, ir: CompilerIR):
  ASTVisit<void, string>
{
  return {
    visit_literal(tree: LiteralNode, param: void): string {
      let [t, _] = ir.type_table[tree.id];
      if (t === INT) {
        return tree.value.toString();
      } else if (t === FLOAT) {
        // Make sure that even whole numbers are emitting as floating-point
        // literals.
        let out = tree.value.toString();
        if (out.indexOf(".") === -1) {
          return out + ".0";
        } else {
          return out;
        }
      } else {
        throw "error: unknown literal type";
      }
    },

    visit_seq(tree: SeqNode, param: void): string {
      return emit_seq(tree, ",\n", fself);
    },

    visit_let(tree: LetNode, param: void): string {
      let varname = shadervarsym(nearest_quote(ir, tree.id), tree.id);
      return varname + " = " + paren(fself(tree.expr));
    },

    visit_assign(tree: AssignNode, param: void): string {
      let vs = (id:number) => shadervarsym(nearest_quote(ir, tree.id), id);
      return emit_assign(ir, fself, tree, vs);
    },

    visit_lookup(tree: LookupNode, param: void): string {
      let vs = (id:number) => shadervarsym(nearest_quote(ir, tree.id), id);
      return emit_lookup(ir, fself, emit_extern, tree, vs);
    },

    visit_unary(tree: UnaryNode, param: void): string {
      let p = fself(tree.expr);
      return tree.op + paren(p);
    },

    visit_binary(tree: BinaryNode, param: void): string {
      return paren(fself(tree.lhs)) + " " +
             tree.op + " " +
             paren(fself(tree.rhs));
    },

    visit_quote(tree: QuoteNode, param: void): string {
      throw "unimplemented";
    },

    visit_escape(tree: EscapeNode, param: void): string {
      if (tree.kind === "splice") {
        return splicesym(tree.id);
      } else if (tree.kind === "persist") {
        return shadervarsym(nearest_quote(ir, tree.id), tree.id);
      } else {
        throw "error: unknown escape kind";
      }
    },

    visit_run(tree: RunNode, param: void): string {
      throw "unimplemented";
    },

    visit_fun(tree: FunNode, param: void): string {
      throw "unimplemented";
    },

    visit_call(tree: CallNode, param: void): string {
      if (frag_expr(tree)) {
        // The argument must be a literal quote node.
        let arg = tree.args[0];
        if (arg.tag === "quote") {
          let quote = <QuoteNode> arg;

          // TODO Maybe this should move to the end of emission instead of the
          // call rule.

          // Assign to all the variables corresponding to persists and free
          // variables for the fragment shader's quotation.
          let subprog = ir.progs[quote.id];
          let assignments: string[] = [];
          for (let esc of subprog.persist) {
            let varname = shadervarsym(subprog.id, esc.id);
            let value = fself(esc.body);
            assignments.push(`${varname} = ${paren(value)}`);
          }
          for (let fv of subprog.free) {
            let destvar = shadervarsym(subprog.id, fv);
            let srcvar = shadervarsym(ir.progs[subprog.quote_parent].id, fv);
            assignments.push(`${destvar} = ${srcvar}`);
          }

          if (assignments.length) {
            return "/* pass to fragment shader */\n" +
                   assignments.join(",\n");
          } else {
            return "";
          }

        } else {
          throw "error: non-quote used with frag";
        }
      }

      // Check that it's a static call.
      if (tree.fun.tag === "lookup") {
        let fun = fself(tree.fun);
        let args: string[] = [];
        for (let arg of tree.args) {
          args.push(fself(arg));
        }
        return fun + "(" + args.join(", ") + ")";
      }

      throw "error: GLSL backend is not higher-order";
    },

    visit_extern(tree: ExternNode, param: void): string {
      let defid = ir.defuse[tree.id];
      let name = ir.externs[defid];
      return emit_extern(name, null);
    },

    visit_persist(tree: PersistNode, param: void): string {
      throw "error: persist cannot appear in source";
    },

  };
}

export function get_compile(ir: CompilerIR): Compile {
  let rules = compile_rules(f, ir);
  function f (tree: SyntaxNode): string {
    return ast_visit(rules, tree, null);
  };
  return f;
}

function emit_decl(qualifier: string, type: string, name: string) {
  return qualifier + " " + type + " " + name + ";";
}

function emit_type(type: Type): string {
  if (type instanceof PrimitiveType) {
    let name = TYPE_NAMES[type.name];
    if (name === undefined) {
      throw "error: primitive type " + type.name + " unsupported in GLSL";
    } else {
      return name;
    }
  } else {
    throw "error: type unsupported in GLSL: " + type;
  }
}

// Emit a declaration for a variable going into or out of the current shader
// program. The variable reflects an escape in this program or a subprogram.
// The flags:
// - `kind`, indicating whether this is an vertex (outer) shader program or a
//   fragment (inner) shader
// - `out`, indicating whether the variable is going into or out of the stage
function persist_decl(ir: CompilerIR, progid: number, valueid: number, varid: number,
    kind: ProgKind, out: boolean): string {
  let [type, _] = ir.type_table[valueid];

  // Array types indicate an attribute. Use the element type. Attributes get
  // no special qualifier distinction from uniforms; they both just get marked
  // as `in` variables.
  let decl_type = type;
  let element_type = _unwrap_array(decl_type);
  let attribute = element_type != decl_type;  // As opposed to uniform.
  decl_type = element_type;

  // Determine the type qualifier. In WebGL 2, this will be as simple as:
  // let qual = out ? "out" : "in";
  // Sadly, in WebGL 1, we need more complex qualifiers.
  let qual: string;
  if (kind === ProgKind.vertex) {
    if (out) {
      qual = "varying";
    } else {  // in
      if (attribute) {
        qual = "attribute";
      } else {
        qual = "uniform";
      }
    }
  } else if (kind === ProgKind.fragment) {
    if (out) {
      throw "error: fragment outputs not allowed";
    } else {
      qual = "varying";
    }
  } else {
    throw "error: unknown shader kind";
  }

  return emit_decl(qual, emit_type(decl_type), shadervarsym(progid, varid));
}

export function compile_prog(compile: Compile,
    ir: CompilerIR, progid: number): string {
  // TODO compile the functions

  let prog = ir.progs[progid];

  // Check whether this is a vertex or fragment shader.
  let kind = prog_kind(ir, progid);
  if (kind !== ProgKind.vertex && kind !== ProgKind.fragment) {
    throw "error: unexpected program kind";
  }

  // Declare `in` variables for the persists and free variables.
  let decls: string[] = [];
  for (let esc of prog.persist) {
    decls.push(persist_decl(ir, progid, esc.body.id, esc.id, kind, false));
  }
  for (let fv of prog.free) {
    decls.push(persist_decl(ir, progid, fv, fv, kind, false));
  }

  // Declare `out` variables for the persists (and free variables) in the
  // subprogram. There can be at most one subprogram for every shader.
  if (prog.quote_children.length > 1) {
    throw "error: too many subprograms";
  } else if (prog.quote_children.length === 1) {
    let subprog = ir.progs[prog.quote_children[0]];
    for (let esc of subprog.persist) {
      decls.push(persist_decl(ir, subprog.id, esc.body.id, esc.id, kind, true));
    }
    for (let fv of subprog.free) {
      decls.push(persist_decl(ir, subprog.id, fv, fv, kind, true));
    }
  }

  // Emit the bound variable declarations.
  let local_decls: string[] = [];
  for (let id of prog.bound) {
    let [t, _] = ir.type_table[id];
    local_decls.push(`${emit_type(t)} ${shadervarsym(progid, id)};\n`);
  }
  let local_decls_s = local_decls.join("");

  // Wrap the code in a "main" function.
  let code = emit_body(compile, prog.body, "");
  code = local_decls_s + code;
  let main = "void main() {\n" + indent(code, true) + "\n}";

  // This version of GLSL requires a precision declaration.
  let out = "precision mediump float;\n";

  // Concatenate the declarations and the main function.
  if (decls.length) {
    out += decls.join("\n") + "\n";
  }
  out += main;
  return out;
}

// Determine the stage kind of a Prog: render, vertex, or fragment. Uses these
// definitions, which are based on containment and annotations:
// - A fragment program is a shader program contained in another shader
//   program.
// - A vertex program is a shader program that is either not nested in any
//   other program or whose containing program is a function program.
// - A render program is any function program.
// - Anything else is an ordinary program.
export enum ProgKind {
  ordinary,
  render,
  vertex,
  fragment,
}
export function prog_kind(ir: CompilerIR, progid: number): ProgKind {
  let prog = ir.progs[progid];
  if (prog.annotation === "f") {
    return ProgKind.render;
  } else if (prog.annotation === "s") {
    if (prog.quote_parent === null) {
      return ProgKind.vertex;
    }
    let parprog = ir.progs[prog.quote_parent];
    if (parprog.annotation === "f") {
      return ProgKind.vertex;
    } else {
      return ProgKind.fragment;
    }
  } else {
    return ProgKind.ordinary;
  }
}

}
