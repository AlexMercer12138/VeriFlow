module child (
    input  logic clk,
    input  logic enable,
    output logic done
);
endmodule

module direction_child (
    input  logic a,
    output logic y,
    inout  wire  io
);
endmodule

module top (
    input  logic clk,
    output logic done
);
    logic next_data;

    child u_child (
        .clk(clk),
        .enable(1'b1),
        .done(done)
    );

    always_comb begin
        next_data = 1'b0;
    end
endmodule

module edge_top (
    input  logic source,
    inout  wire  shared,
    output logic constant_out,
    output logic expression_out
);
    logic unused_done;

    child u_fanout (
        .clk(source),
        .enable(),
        .done(unused_done)
    );
    child u_raw (
        .clk(source),
        .enable(source & shared),
        .done()
    );

    assign constant_out = 1'b0;
    assign expression_out = source & shared;
endmodule

module connection_direction_top (
    input  logic       a,
    inout  wire  [1:0] shared,
    output logic [1:0] y
);
    direction_child u_selected (
        .a(a),
        .y(y[0]),
        .io(shared[0])
    );
endmodule

module positional_direction_top (
    input  logic a,
    inout  wire  shared,
    output logic y
);
    direction_child u_positional (a, y, shared);
endmodule

module assignment_target_top (
    input  logic       a,
    input  logic       b,
    output logic [1:0] y,
    output logic       z
);
    assign y[1] = a;
    assign {z, y[0]} = {a, b};
endmodule

module dynamic_target_top (
    input  logic       idx,
    input  logic       value,
    output logic [1:0] y
);
    direction_child u_dynamic (
        .a(value),
        .y(y[idx]),
        .io()
    );
    assign y[idx] = value;
endmodule
